// Metal host for gpu_msm.metal: the pipeline and a queue built once; two sets of block buffers (points, per-window order and
// starts) and the bucket sums, made when a Groth16 step first needs them and freed after it (tacit_msm_release), so they do
// not sit through the other stages. While the GPU adds one block the CPU writes the next into the other set; the queue runs
// the blocks in order, and the bucket sums carry from one to the next. One caller at a time (gpu_msm_darwin.go locks).
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <stdint.h>
#include <string.h>

static id<MTLDevice> g_dev;
static id<MTLComputePipelineState> g_pso;
static id<MTLCommandQueue> g_queue;
static id<MTLBuffer> g_pts[2], g_order[2], g_start[2], g_out;
static id<MTLCommandBuffer> g_cb[2];
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

// The buffers, made if they are not there.
int tacit_msm_alloc(void) {
    if (g_out) return 0;
    for (int s = 0; s < 2; s++) {
        g_pts[s] = [g_dev newBufferWithLength:(size_t)g_cap * 64 options:MTLResourceStorageModeShared];
        g_order[s] = [g_dev newBufferWithLength:(size_t)g_cap * g_windows * 4 options:MTLResourceStorageModeShared];
        g_start[s] = [g_dev newBufferWithLength:(size_t)(g_nb + 1) * g_windows * 4 options:MTLResourceStorageModeShared];
        if (!g_pts[s] || !g_order[s] || !g_start[s]) return -4;
    }
    g_out = [g_dev newBufferWithLength:(size_t)g_nb * g_windows * 96 options:MTLResourceStorageModeShared];
    return g_out ? 0 : -4;
}

void tacit_msm_release(void) {
    for (int s = 0; s < 2; s++) {
        g_pts[s] = g_order[s] = g_start[s] = nil;
        g_cb[s] = nil;
    }
    g_out = nil;
}

// Where the caller writes set s's points, per-window order and starts, and reads the bucket sums.
void *tacit_msm_pts(int s) { return g_pts[s].contents; }
void *tacit_msm_order(int s) { return g_order[s].contents; }
void *tacit_msm_start(int s) { return g_start[s].contents; }
void *tacit_msm_out(void) { return g_out.contents; }

// Waits for the block last sent from set s; nonzero if it failed.
int tacit_msm_wait(int s) {
    if (!g_cb[s]) return 0;
    [g_cb[s] waitUntilCompleted];
    int rc = g_cb[s].error ? -11 : 0;
    g_cb[s] = nil;
    return rc;
}

// Sends set s's n points to be added into the bucket sums (from infinity when `first`), without waiting.
int tacit_msm_send(int s, uint32_t n, uint32_t first) {
    @autoreleasepool {
        if (n > g_cap) return -10;
        id<MTLCommandBuffer> cb = [g_queue commandBuffer];
        id<MTLComputeCommandEncoder> enc = [cb computeCommandEncoder];
        [enc setComputePipelineState:g_pso];
        [enc setBuffer:g_pts[s] offset:0 atIndex:0];
        [enc setBuffer:g_order[s] offset:0 atIndex:1];
        [enc setBuffer:g_start[s] offset:0 atIndex:2];
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
        g_cb[s] = cb;
        return 0;
    }
}
