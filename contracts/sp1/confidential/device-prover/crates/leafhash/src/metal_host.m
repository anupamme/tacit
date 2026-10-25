// Metal host for leafhash.metal: its two pipelines and a queue, built once; each call runs one row or node per thread.
// Memory is shared with the GPU, so a page-aligned input or output is used where it lies; anything else is copied.
// Command buffers are per call, so concurrent callers are safe.
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>

static id<MTLDevice> g_dev;
static id<MTLComputePipelineState> g_pso, g_cmp, g_grind;
static id<MTLCommandQueue> g_queue;
static id<MTLBuffer> g_ext, g_int;

int tacit_leafhash_init(const char *msl, const uint64_t *ext, const uint64_t *intc, char *name, size_t name_len) {
    @autoreleasepool {
        // A command-line process has no default device; any device will do.
        id<MTLDevice> dev = MTLCreateSystemDefaultDevice();
        if (!dev) {
            NSArray<id<MTLDevice>> *all = MTLCopyAllDevices();
            if (all.count) dev = all[0];
        }
        if (!dev) return -1;
        NSError *err = nil;
        id<MTLLibrary> lib = [dev newLibraryWithSource:[NSString stringWithUTF8String:msl] options:nil error:&err];
        if (!lib) return -2;
        id<MTLFunction> fn = [lib newFunctionWithName:@"leaf_hash"];
        if (!fn) return -3;
        id<MTLComputePipelineState> pso = [dev newComputePipelineStateWithFunction:fn error:&err];
        if (!pso) return -4;
        id<MTLFunction> cfn = [lib newFunctionWithName:@"compress_pairs"];
        id<MTLComputePipelineState> cmp = cfn ? [dev newComputePipelineStateWithFunction:cfn error:&err] : nil;
        if (!cmp) return -6;
        id<MTLFunction> gfn = [lib newFunctionWithName:@"grind"];
        id<MTLComputePipelineState> grind = gfn ? [dev newComputePipelineStateWithFunction:gfn error:&err] : nil;
        if (!grind) return -7;
        g_ext = [dev newBufferWithBytes:ext length:8 * 3 * 32 options:MTLResourceStorageModeShared];
        g_int = [dev newBufferWithBytes:intc length:56 * 32 options:MTLResourceStorageModeShared];
        g_queue = [dev newCommandQueue];
        if (!g_ext || !g_int || !g_queue) return -5;
        g_dev = dev;
        g_pso = pso;
        g_cmp = cmp;
        g_grind = grind;
        strncpy(name, dev.name.UTF8String, name_len - 1);
        name[name_len - 1] = 0;
        return 0;
    }
}

// The caller's memory as a GPU buffer, without a copy when it starts on a page (the length is taken to the page's end,
// which the kernel never reads or writes past `len`); otherwise a copy, made only for input.
static id<MTLBuffer> shared(const void *p, size_t len, int input, int *wrapped) {
    size_t page = (size_t)getpagesize();
    *wrapped = 0;
    if (((uintptr_t)p % page) == 0) {
        id<MTLBuffer> b = [g_dev newBufferWithBytesNoCopy:(void *)p length:(len + page - 1) / page * page
                                                  options:MTLResourceStorageModeShared deallocator:nil];
        if (b) { *wrapped = 1; return b; }
    }
    return input ? [g_dev newBufferWithBytes:p length:len options:MTLResourceStorageModeShared]
                 : [g_dev newBufferWithLength:len options:MTLResourceStorageModeShared];
}

int tacit_leafhash_run(const uint32_t *rows, uint32_t n, uint32_t width, uint32_t monty, uint64_t *out) {
    @autoreleasepool {
        size_t rlen = (size_t)n * width * 4, olen = (size_t)n * 32;
        int rw, ow;
        id<MTLBuffer> rb = shared(rows, rlen, 1, &rw);
        id<MTLBuffer> ob = shared(out, olen, 0, &ow);
        if (!rb || !ob) return -1;
        id<MTLCommandBuffer> cb = [g_queue commandBuffer];
        id<MTLComputeCommandEncoder> enc = [cb computeCommandEncoder];
        [enc setComputePipelineState:g_pso];
        [enc setBuffer:rb offset:0 atIndex:0];
        [enc setBuffer:ob offset:0 atIndex:1];
        [enc setBuffer:g_ext offset:0 atIndex:2];
        [enc setBuffer:g_int offset:0 atIndex:3];
        [enc setBytes:&width length:4 atIndex:4];
        [enc setBytes:&n length:4 atIndex:5];
        [enc setBytes:&monty length:4 atIndex:6];
        NSUInteger tg = MIN((NSUInteger)64, g_pso.maxTotalThreadsPerThreadgroup);
        [enc dispatchThreads:MTLSizeMake(n, 1, 1) threadsPerThreadgroup:MTLSizeMake(tg, 1, 1)];
        [enc endEncoding];
        [cb commit];
        [cb waitUntilCompleted];
        if (cb.error) return -2;
        if (!ow) memcpy(out, ob.contents, olen);
        return 0;
    }
}

int tacit_compress_run(const uint64_t *prev, uint32_t n, uint64_t *out) {
    @autoreleasepool {
        size_t ilen = (size_t)n * 64, olen = (size_t)n * 32;
        int iw, ow;
        id<MTLBuffer> ib = shared(prev, ilen, 1, &iw);
        id<MTLBuffer> ob = shared(out, olen, 0, &ow);
        if (!ib || !ob) return -1;
        id<MTLCommandBuffer> cb = [g_queue commandBuffer];
        id<MTLComputeCommandEncoder> enc = [cb computeCommandEncoder];
        [enc setComputePipelineState:g_cmp];
        [enc setBuffer:ib offset:0 atIndex:0];
        [enc setBuffer:ob offset:0 atIndex:1];
        [enc setBuffer:g_ext offset:0 atIndex:2];
        [enc setBuffer:g_int offset:0 atIndex:3];
        [enc setBytes:&n length:4 atIndex:4];
        NSUInteger tg = MIN((NSUInteger)64, g_cmp.maxTotalThreadsPerThreadgroup);
        [enc dispatchThreads:MTLSizeMake(n, 1, 1) threadsPerThreadgroup:MTLSizeMake(tg, 1, 1)];
        [enc endEncoding];
        [cb commit];
        [cb waitUntilCompleted];
        if (cb.error) return -2;
        if (!ow) memcpy(out, ob.contents, olen);
        return 0;
    }
}

// One dispatch of the proof-of-work search over nonces [start, start + n): the least passing nonce, or 0xffffffff.
int tacit_grind_run(const uint64_t *state, const uint32_t *prefix, uint32_t plen, uint32_t bits, uint32_t start, uint32_t n, uint32_t *found) {
    @autoreleasepool {
        uint32_t none = 0xffffffffu, pre[16] = {0};
        memcpy(pre, prefix, plen * 4);
        id<MTLBuffer> fb = [g_dev newBufferWithBytes:&none length:4 options:MTLResourceStorageModeShared];
        if (!fb) return -1;
        id<MTLCommandBuffer> cb = [g_queue commandBuffer];
        id<MTLComputeCommandEncoder> enc = [cb computeCommandEncoder];
        [enc setComputePipelineState:g_grind];
        [enc setBytes:state length:96 atIndex:0];
        [enc setBytes:pre length:64 atIndex:1];
        [enc setBuffer:g_ext offset:0 atIndex:2];
        [enc setBuffer:g_int offset:0 atIndex:3];
        [enc setBytes:&plen length:4 atIndex:4];
        [enc setBytes:&bits length:4 atIndex:5];
        [enc setBytes:&start length:4 atIndex:6];
        [enc setBuffer:fb offset:0 atIndex:7];
        NSUInteger tg = MIN((NSUInteger)64, g_grind.maxTotalThreadsPerThreadgroup);
        [enc dispatchThreads:MTLSizeMake(n, 1, 1) threadsPerThreadgroup:MTLSizeMake(tg, 1, 1)];
        [enc endEncoding];
        [cb commit];
        [cb waitUntilCompleted];
        if (cb.error) return -2;
        *found = *(uint32_t *)fb.contents;
        return 0;
    }
}
