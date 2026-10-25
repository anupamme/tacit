// Metal host for leafhash.metal: one pipeline and queue, built once; each call copies a block of rows in, hashes one row
// per thread, and copies the digests out. Command buffers are per call, so concurrent callers are safe.
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <stdint.h>
#include <string.h>

static id<MTLDevice> g_dev;
static id<MTLComputePipelineState> g_pso;
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
        g_ext = [dev newBufferWithBytes:ext length:8 * 3 * 32 options:MTLResourceStorageModeShared];
        g_int = [dev newBufferWithBytes:intc length:56 * 32 options:MTLResourceStorageModeShared];
        g_queue = [dev newCommandQueue];
        if (!g_ext || !g_int || !g_queue) return -5;
        g_dev = dev;
        g_pso = pso;
        strncpy(name, dev.name.UTF8String, name_len - 1);
        name[name_len - 1] = 0;
        return 0;
    }
}

int tacit_leafhash_run(const uint32_t *rows, uint32_t n, uint32_t width, uint32_t monty, uint64_t *out) {
    @autoreleasepool {
        size_t rlen = (size_t)n * width * 4, olen = (size_t)n * 32;
        id<MTLBuffer> rb = [g_dev newBufferWithBytes:rows length:rlen options:MTLResourceStorageModeShared];
        id<MTLBuffer> ob = [g_dev newBufferWithLength:olen options:MTLResourceStorageModeShared];
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
        memcpy(out, ob.contents, olen);
        return 0;
    }
}
