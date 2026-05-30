'use strict';
/*
 * QBDI 真机自测: 在目标进程里用 QBDI VM 重放 libc!getpid (极小函数, 无 ANR 风险),
 * 验证整条链路: helper memfd 加载 -> newVM -> 插桩 -> registerTraceCallbacks
 *              -> call -> shutdown 落盘 trace_bundle.pb。
 *
 * trace 输出目录: 自动取当前 App 的 cache 目录 (进程内可写)。
 * 勿用 /data/local/tmp (App 无写权限) 或 /data/data/<pkg> 根目录 (可能不存在)。
 */
function findMod(n) {
    try { if (typeof Process !== 'undefined' && Process.findModuleByName) return Process.findModuleByName(n); } catch (e) {}
    try { if (typeof Module !== 'undefined' && Module.findModuleByName) return Module.findModuleByName(n); } catch (e) {}
    return null;
}
function findExp(lib, sym) {
    try { if (typeof Module !== 'undefined' && Module.findExportByName) return Module.findExportByName(lib, sym); } catch (e) {}
    return null;
}

function resolveTraceOutDir() {
    var dir = null;
    try {
        if (typeof Java !== 'undefined' && typeof Java.perform === 'undefined' && typeof Java.ready === 'function') {
            Java.perform = Java.ready;
        }
        if (typeof Java !== 'undefined' && typeof Java.perform === 'function') {
            Java.perform(function () {
                var AT = Java.use('android.app.ActivityThread');
                var ctx = AT.currentApplication().getApplicationContext();
                var cache = ctx.getCacheDir().getAbsolutePath().toString();
                var File = Java.use('java.io.File');
                var sub = File.$new(cache + '/qbdi_trace');
                if (!sub.exists()) sub.mkdirs();
                dir = sub.getAbsolutePath().toString();
            });
        }
    } catch (e) {}
    if (dir) return dir;
    // fallback: 从 cmdline 拼 cache 路径 (需 App 已启动过)
    try {
        var f = new File('/proc/self/cmdline', 'r');
        if (f && f.read) {
            var raw = f.read(256);
            if (raw) {
                var pkg = String(raw).split('\0')[0];
                if (pkg && pkg.indexOf('.') > 0) return '/data/data/' + pkg + '/cache/qbdi_trace';
            }
        }
    } catch (e2) {}
    return null;
}

console.log('[selftest] typeof qbdi = ' + (typeof qbdi));
if (typeof qbdi === 'undefined') {
    console.log('[selftest] FAIL: qbdi 未注入 (引擎没带 QBDI feature?)');
} else {
    try {
        var OUTDIR = resolveTraceOutDir();
        if (!OUTDIR) throw new Error('无法确定 trace 输出目录 (请先启动目标 App 再 inject)');
        console.log('[selftest] trace 输出目录: ' + OUTDIR);

        var m = findMod('libc.so');
        var getpidP = findExp('libc.so', 'getpid');
        console.log('[selftest] libc base=' + (m ? m.base : '?') + ' getpid=' + getpidP);
        if (!m || !getpidP) throw new Error('找不到 libc.so / getpid');

        var getpid = BigInt(getpidP.toString());

        var vm = qbdi.newVM();
        console.log('[selftest] newVM = ' + vm + '  err=' + qbdi.lastError());
        if (!vm) throw new Error('newVM 失败');

        console.log('[selftest] step1 allocateVirtualStack');
        var s1 = qbdi.allocateVirtualStack(vm, 0x100000);
        console.log('[selftest] step1 ok=' + s1 + ' err=' + qbdi.lastError());

        console.log('[selftest] step2 addInstrumentedRange');
        var s2 = qbdi.addInstrumentedRange(vm, getpid, getpid + 0x400n);
        console.log('[selftest] step2 ok=' + s2 + ' err=' + qbdi.lastError());

        console.log('[selftest] step3 recordMemoryAccess');
        var s3 = qbdi.recordMemoryAccess(vm, qbdi.MEMORY_READ_WRITE);
        console.log('[selftest] step3 ok=' + s3 + ' err=' + qbdi.lastError());

        console.log('[selftest] step4 registerTraceCallbacks(vm, getpid, ' + OUTDIR + ')');
        var ok = qbdi.registerTraceCallbacks(vm, getpid, OUTDIR);
        console.log('[selftest] registerTraceCallbacks = ' + ok + '  err=' + qbdi.lastError());
        if (!ok) throw new Error('registerTraceCallbacks 失败');

        var r = qbdi.call(vm, getpid);
        console.log('[selftest] qbdi.call(getpid) = ' + r + ' (应等于真实 pid)');

        qbdi.unregisterTraceCallbacks(vm);
        qbdi.destroyVM(vm);
        qbdi.shutdown();
        console.log('[selftest] OK — ' + OUTDIR + '/trace_bundle.pb');
    } catch (e) {
        console.log('[selftest] EXC ' + e + ' | ' + (e.stack || ''));
    }
}
