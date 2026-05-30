/*
 * QBDI 指令级 Trace 模板 — rustfrida (QuickJS) 真实 API 版
 *
 * 前置条件: 引擎必须用 QBDI feature 编译并部署:
 *     ./deploy.sh --qbdi
 * 否则全局 qbdi 对象不存在 (typeof qbdi === 'undefined')。
 *
 * 工作原理 (与标准 Frida Stalker / 你想象的 addCodeCB 不同):
 *   - rustfrida 的 QBDI 绑定是一组扁平函数: qbdi.newVM() / qbdi.run() / ...
 *   - Trace 不走 JS 逐指令回调 (那样每条指令回 JS 太慢), 而是由原生 qbdi_helper.so
 *     把"指令 + 寄存器 + 内存访问 + call/ret"写成 protobuf trace bundle 落盘,
 *     离线再解码。这样指令级追踪才扛得住高频代码。
 *   - registerTraceCallbacks 会插桩目标模块的可执行段并挂上 code/mem/call/ret 回调;
 *     真正执行要靠 qbdi.run()/qbdi.call() 在 VM 内重放目标函数。
 *
 * 用法:
 *   1) 改下面的 LIB / OFFSET (目标 native 函数) 和 OUTPUT_DIR (目标应用私有目录)
 *   2) ./run.sh com.sankuai.sailor.afooddelivery scripts/qbdi_trace.js
 *   3) 触发目标逻辑, trace bundle 落在 OUTPUT_DIR/trace_bundle.pb,
 *      ./run.sh --pull-trace <包名> 拉取并离线解码 (tools/trace_decode.py)。
 *
 * 真机实测要点 (踩过的坑):
 *   - registerTraceCallbacks 的 target 必须是【可执行地址】(mod.base+offset 或导出符号),
 *     传模块基址会报 "not found in /proc/self/maps"。
 *   - attach(-p PID) 模式默认输出目录为空, 必须显式传 OUTPUT_DIR。
 *   - 必须 qbdi.shutdown() 才会同步 flush 并发布 trace_bundle.pb。
 */
'use strict';

if (typeof Java !== 'undefined' && typeof Java.perform === 'undefined' && typeof Java.ready === 'function') {
    Java.perform = Java.ready;
}

function log(m) { console.log('[qbdi-trace] ' + m); }

// ===== 配置目标 =====
var LIB = 'libmtguard.so';
var OFFSET = 0x3a4b0;          // 目标函数相对模块基址的偏移 (从 IDA/objdump 拿)
var STACK_SIZE = 0x100000;     // QBDI 虚拟栈大小 (1MB)
var OUTPUT_DIR = '/data/data/com.sankuai.sailor.afooddelivery/cache/qbdi_trace';

function findModule(name) {
    try { if (typeof Process !== 'undefined' && Process.findModuleByName) return Process.findModuleByName(name); } catch (e) {}
    try { if (typeof Module !== 'undefined' && Module.findModuleByName) return Module.findModuleByName(name); } catch (e) {}
    return null;
}

Java.perform(function () {
    if (typeof qbdi === 'undefined') {
        log('\u2717 qbdi 未注入 \u2014 引擎需用 ./deploy.sh --qbdi 重新编译部署');
        return;
    }

    // trace 写盘前目录必须已存在 (helper 不会自动 mkdir)
    try {
        var File = Java.use('java.io.File');
        var outDir = File.$new(OUTPUT_DIR);
        if (!outDir.exists()) outDir.mkdirs();
        log('输出目录: ' + OUTPUT_DIR);
    } catch (e) {
        log('警告: 无法创建输出目录, 请先 su -c "mkdir -p ' + OUTPUT_DIR + '"');
    }

    var mod = findModule(LIB);
    if (!mod) { log('\u2717 找不到模块: ' + LIB + ' (是否已加载?)'); return; }
    var target = mod.base.add(OFFSET);
    log('目标: ' + LIB + '@' + OFFSET.toString(16) + ' -> ' + target);

    var vm = qbdi.newVM();
    if (!vm) { log('\u2717 qbdi.newVM 失败: ' + qbdi.lastError()); return; }

    if (!qbdi.allocateVirtualStack(vm, STACK_SIZE)) {
        log('\u2717 allocateVirtualStack 失败: ' + qbdi.lastError());
        qbdi.destroyVM(vm);
        return;
    }

    // 插桩目标所在模块的可执行段
    qbdi.addInstrumentedModuleFromAddr(vm, target);
    // 把模块元数据写进 trace bundle, 方便离线还原偏移
    try { qbdi.setTraceBundleMetadata(LIB, mod.base); } catch (e) {}
    // 记录内存读访问 (要看写访问加 qbdi.recordMemoryAccess(vm, qbdi.MEMORY_READ_WRITE))
    qbdi.recordMemoryAccess(vm, qbdi.MEMORY_READ);

    // 注册 trace 回调; attach 模式必须显式传输出目录
    if (!qbdi.registerTraceCallbacks(vm, target, OUTPUT_DIR)) {
        log('\u2717 registerTraceCallbacks 失败: ' + qbdi.lastError());
        qbdi.destroyVM(vm);
        return;
    }
    log('\u2713 trace 已挂载, 在 onEnter 用 qbdi.call 在 VM 内重放目标');

    // 在目标被自然调用时, 用 QBDI 在 VM 内重放它 -> 产生 trace
    Interceptor.attach(target, {
        onEnter: function (args) {
            log('hit target, 用 QBDI 重放...');
            var r = qbdi.call(vm, target, args[0], args[1], args[2], args[3]);
            // shutdown 才会同步 flush + 发布 trace_bundle.pb
            if (qbdi.shutdown) qbdi.shutdown();
            log('qbdi.call 返回 = ' + r + ' (trace_bundle.pb 已写盘, ./run.sh --pull-trace 拉取)');
            // 用 QBDI 重放过了, 让原调用直接返回该结果, 避免重复执行
            this.replayed = r;
        },
        onLeave: function (retval) {
            if (this.replayed !== undefined && this.replayed !== null) {
                retval.replace(this.replayed);
            }
        }
    });

    log('=== Ready. 触发目标逻辑后 adb pull trace_bundle.pb 离线解码 ===');
});
