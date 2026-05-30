/*
 * Qbdi — KSUhook 高层动态调试封装 (rustfrida / QuickJS)
 *
 * 把零散的底层原语包成一套类 LLDB 的 API。分两层:
 *
 *  ── Tier 1 (任意地址读写寄存器/内存) ──  基于 Interceptor + Memory
 *     当前部署的二进制即可用, 无需 QBDI feature。等价于 LLDB 的
 *     `register read/write` + `memory write`, 在被 hook 的指令地址处生效。
 *       Qbdi.setInstructionHook(addr, fn)   // 在某地址挂回调 (fn 内可读写寄存器/内存)
 *       Qbdi.readRegister("X0") / writeRegister("X0", 0)
 *       Qbdi.readMemory(addr, n) / writeMemory(addr, [..])
 *
 *  ── Tier 2 (全量指令级 Trace) ──  基于原生 qbdi.* (protobuf trace bundle)
 *     需用 ./deploy.sh --qbdi 重新编译部署, 否则全局 qbdi 不存在。
 *       Qbdi.setupTrace(base, size) ; Qbdi.hookWithQbdi(target) ; Qbdi.stopTrace()
 *     Trace 落盘到 App cache 目录 (进程内可写):
 *       /data/data/<包名>/cache/qbdi_trace/trace_bundle.pb
 *     勿用 /data/local/tmp (App 无写权限)。用 `./run.sh --pull-trace <包名>` 拉取解码。
 *
 * 使用: 把本文件内容粘到你的 hook 脚本顶部, 或用 run.sh --trace 自动注入。
 */
'use strict';

(function () {
    if (typeof Java !== 'undefined' && typeof Java.perform === 'undefined' && typeof Java.ready === 'function') {
        Java.perform = Java.ready;
    }

    function toBig(v) {
        if (typeof v === 'bigint') return v;
        if (typeof v === 'number') return BigInt(Math.trunc(v));
        if (v && typeof v.toString === 'function') { try { return BigInt(v.toString()); } catch (e) {} }
        return 0n;
    }
    function P(addr) { return (typeof addr === 'object' && addr.readU8) ? addr : ptr(toBig(addr).toString()); }

    // 寄存器名 -> Interceptor ctx 字段。x0..x30 / sp / pc / lr 由引擎暴露。
    function ctxKey(name) {
        var n = String(name).toLowerCase();
        if (n === 'lr') return 'lr';
        if (n === 'sp') return 'sp';
        if (n === 'pc') return 'pc';
        if (n === 'fp' || n === 'x29') return 'x29';
        if (n[0] === 'w') return 'x' + n.slice(1);   // w0 -> x0 (取低 32 位)
        if (n[0] === 'x') return n;                  // x0..x30
        throw new Error('Qbdi: 未知寄存器 ' + name);
    }
    function isWReg(name) { return String(name).toLowerCase()[0] === 'w'; }

    var Qbdi = {
        _cur: null,        // 当前 Interceptor 回调的 ctx (this)
        _vm: null,         // Tier2 QBDI VM 句柄
        _hooks: [],

        // ---------- Tier 1: Interceptor + Memory ----------

        // 在 addr 处挂一个回调; fn 内可用 Qbdi.readRegister/writeRegister/readMemory/writeMemory。
        // fn 的 this 即 ctx, 也可直接 this.x0 / this.sp 等。
        setInstructionHook: function (addr, fn) {
            var self = this;
            var listener = Interceptor.attach(P(addr), {
                onEnter: function () {
                    self._cur = this;
                    try { fn.call(this, this); } finally { self._cur = null; }
                }
            });
            this._hooks.push(listener);
            return listener;
        },

        readRegister: function (name) {
            if (!this._cur) throw new Error('Qbdi.readRegister 只能在 setInstructionHook 回调内调用');
            var v = toBig(this._cur[ctxKey(name)]);
            return isWReg(name) ? Number(BigInt.asUintN(32, v)) : v;
        },

        writeRegister: function (name, value) {
            if (!this._cur) throw new Error('Qbdi.writeRegister 只能在 setInstructionHook 回调内调用');
            this._cur[ctxKey(name)] = toBig(value);
            return true;
        },

        readMemory: function (addr, size) { return P(addr).readByteArray(size); },

        // bytes: 数组 [0x90,...] 或 ArrayBuffer
        writeMemory: function (addr, bytes) {
            P(addr).writeBytes(bytes);
            return true;
        },

        detachAll: function () {
            this._hooks.forEach(function (h) { try { h.detach(); } catch (e) {} });
            this._hooks = [];
            if (typeof Interceptor !== 'undefined' && Interceptor.flush) Interceptor.flush();
        },

        // ---------- Tier 2: 原生 QBDI 全量指令 Trace ----------

        qbdiAvailable: function () { return typeof qbdi !== 'undefined'; },

        // 挂载 trace。
        //   target    : 要追踪的【可执行地址】(函数入口), 不能是模块基址(ELF 头是只读段会报
        //               "not found in /proc/self/maps")。引擎会自动插桩 target 所在模块的可执行段。
        //   outputDir : trace 落盘目录, 【必须已存在且 App 进程可写】。推荐:
        //               /data/data/<包名>/cache/qbdi_trace/  (inject 前 su mkdir -p)
        setupTrace: function (target, outputDir) {
            if (!this.qbdiAvailable()) {
                console.log('[Qbdi] qbdi 未注入 — 需 ./deploy.sh --qbdi 重新编译部署');
                return false;
            }
            var t = toBig(target);
            var vm = qbdi.newVM();
            if (!vm) { console.log('[Qbdi] newVM 失败: ' + qbdi.lastError()); return false; }
            qbdi.allocateVirtualStack(vm, 0x100000);
            qbdi.recordMemoryAccess(vm, qbdi.MEMORY_READ_WRITE);
            var ok = outputDir
                ? qbdi.registerTraceCallbacks(vm, t, outputDir)
                : qbdi.registerTraceCallbacks(vm, t);
            if (!ok) { console.log('[Qbdi] registerTraceCallbacks 失败: ' + qbdi.lastError()); qbdi.destroyVM(vm); return false; }
            this._vm = vm;
            this._target = t;
            console.log('[Qbdi] trace 已挂载 @0x' + t.toString(16) + (outputDir ? (' -> ' + outputDir) : ''));
            return true;
        },

        // 在 target 被自然调用时, 用 QBDI 在 VM 内重放 (产出 trace), 并用其返回值替换原调用。
        hookWithQbdi: function (target) {
            if (!this._vm) { console.log('[Qbdi] 请先 setupTrace()'); return; }
            var self = this;
            var t = P(target);
            Interceptor.attach(t, {
                onEnter: function (args) {
                    var r = qbdi.call(self._vm, toBig(t), toBig(args[0]), toBig(args[1]), toBig(args[2]), toBig(args[3]));
                    this._replay = r;
                    console.log('[Qbdi] qbdi.call 返回=' + r + ' (trace bundle 写盘中)');
                },
                onLeave: function (retval) {
                    if (this._replay !== undefined && this._replay !== null) retval.replace(this._replay);
                }
            });
        },

        stopTrace: function () {
            if (this._vm && this.qbdiAvailable()) {
                qbdi.unregisterTraceCallbacks(this._vm);
                qbdi.destroyVM(this._vm);
                this._vm = null;
                // 关键: shutdown 才会同步 flush 分片并发布 trace_bundle.pb
                if (qbdi.shutdown) qbdi.shutdown();
                console.log('[Qbdi] trace 已停止并 flush (trace_bundle.pb 已写盘)');
            }
        }
    };

    globalThis.Qbdi = Qbdi;
})();
