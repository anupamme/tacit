// Metal host for gpu_msm.metal: the pipeline and a queue built once; buffers for one block (612 MB) made when a Groth16
// step first needs them and freed after it (tacit_msm_release), so they do not sit through the other stages. A
// multi-exponentiation's bucket sums stay on the GPU from block to block. One caller at a time (gpu_msm_darwin.go locks).
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <stdint.h>
#include <string.h>

static id<MTLDevice> g_dev;
static id<MTLComputePipelineState> g_pso;
static id<MTLCommandQueue> g_queue;
static id<MTLBuffer> g_pts, g_order, g_start, g_out;
static uint32_t g_cap, g_nb, g_windows;

int tacit_msm_init(const char *msl, uint32_t cap, uint32_t nb, uint32_t windows, char *name, size_t name_len) {
    @autoreleasepool {
        id<MTLDevice> dev = MTLCreateSystemDefaultDevice();
        if (!dev) {
            NSArray<id<MTLDevice>> *all = MTLCopyAllDevices();
            if (all.count) dev = all[0];
        }
        if (!dev) return -1;
        NSError *err = nil;
        id<MTLLibrary> lib = [dev newLibraryWithSource:[NSString stringWithUTF8String:msl] options:nil error:&err];
        if (!lib) return -2;
        id<MTLFunction> fn = [lib newFunctionWithName:@"bucket_sum"];
        id<MTLComputePipelineState> pso = fn ? [dev newComputePipelineStateWithFunction:fn error:&err] : nil;
        if (!pso) return -3;
        g_queue = [dev newCommandQueue];
        if (!g_queue) return -4;
        g_dev = dev;
        g_pso = pso;
        g_cap = cap;
        g_nb = nb;
        g_windows = windows;
        strncpy(name, dev.name.UTF8String, name_len - 1);
        name[name_len - 1] = 0;
        return 0;
    }
}

// The block buffers, made if they are not there.
int tacit_msm_alloc(void) {
    if (g_pts) return 0;
    g_pts = [g_dev newBufferWithLength:(size_t)g_cap * 64 options:MTLResourceStorageModeShared];
    g_order = [g_dev newBufferWithLength:(size_t)g_cap * g_windows * 4 options:MTLResourceStorageModeShared];
    g_start = [g_dev newBufferWithLength:(size_t)(g_nb + 1) * g_windows * 4 options:MTLResourceStorageModeShared];
    g_out = [g_dev newBufferWithLength:(size_t)g_nb * g_windows * 96 options:MTLResourceStorageModeShared];
    if (!g_pts || !g_order || !g_start || !g_out) { g_pts = g_order = g_start = g_out = nil; return -4; }
    return 0;
}

void tacit_msm_release(void) { g_pts = g_order = g_start = g_out = nil; }

// Where the caller writes a block's points, its per-window order and starts, and reads the bucket sums.
void *tacit_msm_pts(void) { return g_pts.contents; }
void *tacit_msm_order(void) { return g_order.contents; }
void *tacit_msm_start(void) { return g_start.contents; }
void *tacit_msm_out(void) { return g_out.contents; }

// Adds the block's n points into the bucket sums (from infinity when `first`).
int tacit_msm_block(uint32_t n, uint32_t first) {
    @autoreleasepool {
        if (n > g_cap) return -10;
        id<MTLCommandBuffer> cb = [g_queue commandBuffer];
        id<MTLComputeCommandEncoder> enc = [cb computeCommandEncoder];
        [enc setComputePipelineState:g_pso];
        [enc setBuffer:g_pts offset:0 atIndex:0];
        [enc setBuffer:g_order offset:0 atIndex:1];
        [enc setBuffer:g_start offset:0 atIndex:2];
        [enc setBuffer:g_out offset:0 atIndex:3];
        [enc setBytes:&g_nb length:4 atIndex:4];
        [enc setBytes:&n length:4 atIndex:5];
        [enc setBytes:&g_windows length:4 atIndex:6];
        [enc setBytes:&first length:4 atIndex:7];
        NSUInteger total = (NSUInteger)g_nb * g_windows, tg = g_pso.maxTotalThreadsPerThreadgroup;
        if (tg > 256) tg = 256;
        [enc dispatchThreads:MTLSizeMake(total, 1, 1) threadsPerThreadgroup:MTLSizeMake(tg, 1, 1)];
        [enc endEncoding];
        [cb commit];
        [cb waitUntilCompleted];
        return cb.error ? -11 : 0;
    }
}
