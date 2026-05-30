#!/bin/bash
# run.sh - 在手机上启动 rustfrida 并注入目标 App
# 用法:
#   ./run.sh com.zhiliaoapp.musically                # 注入 TikTok (attach)
#   ./run.sh com.zhiliaoapp.musically hook2.js
#   ./run.sh --spawn com.airbnb.android hook.js      # Spawn 模式
#   ./run.sh -s SERIAL com.zhiliaoapp.musically
#   ./run.sh --bg com.airbnb.android hook.js         # 后台运行

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REMOTE_BIN="/data/local/tmp/rustfrida"
REMOTE_SCRIPT_DIR="/data/local/tmp"
DEFAULT_HOOK="hook2.js"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[+]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[-]${NC} $1"; exit 1; }

# 解析参数
SERIAL=""
ADB="adb"
SPAWN_MODE=false
BG_MODE=false
TRACE_MODE=false
RECORD_MEM=false
PULL_TRACE=""

while [ $# -gt 0 ]; do
    case "$1" in
        -s|--serial) SERIAL="$2"; ADB="adb -s $2"; shift 2 ;;
        --spawn)     SPAWN_MODE=true; shift ;;
        --bg)        BG_MODE=true; shift ;;
        --trace)     TRACE_MODE=true; shift ;;
        --trace-mem) TRACE_MODE=true; RECORD_MEM=true; shift ;;
        --pull-trace) PULL_TRACE="$2"; shift 2 ;;
        -h|--help)
            echo "用法: $0 [选项] <包名> [hook脚本]"
            echo "      $0 --trace[-mem] <包名> <lib名> <偏移或符号>"
            echo "      $0 --pull-trace <包名> [输出文件]"
            echo ""
            echo "选项:"
            echo "  --spawn              Spawn 模式（从启动开始 hook）"
            echo "  --bg                 后台运行（hooks 保持活跃）"
            echo "  --trace              QBDI 指令级 Trace (需 ./deploy.sh --qbdi)"
            echo "  --trace-mem          QBDI Trace + 内存读写记录"
            echo "  --pull-trace 包名    从设备拉取 trace_bundle.pb 并离线解码"
            echo "  -s, --serial SERIAL  指定设备"
            echo ""
            echo "示例:"
            echo "  $0 com.airbnb.android hook.js                              # attach + 抓包"
            echo "  $0 --spawn com.zhiliaoapp.musically hook2.js               # spawn"
            echo "  $0 com.sankuai.sailor.afooddelivery hook_keeta_capture.js  # Keeta 签名"
            echo "  $0 --trace com.sankuai.sailor.afooddelivery libmtguard.so 0x5b120"
            echo "  $0 --trace com.zhiliaoapp.musically libc.so open"
            echo "  $0 --pull-trace com.sankuai.sailor.afooddelivery           # 拉取+解码 trace"
            exit 0
            ;;
        *) break ;;
    esac
done

# ===== 拉取并解码 trace_bundle.pb =====
if [ -n "$PULL_TRACE" ]; then
    PKG="$PULL_TRACE"
    OUT="${1:-trace_bundle.pb}"
    REMOTE_CACHE="/data/data/$PKG/cache/qbdi_trace/trace_bundle.pb"
    REMOTE_TMP="/data/local/tmp/trace/$PKG/trace_bundle.pb"
    REMOTE_OLD="/data/data/$PKG/trace_bundle.pb"
    info "从设备拉取 trace_bundle.pb ..."
    $ADB shell "su -c 'cat $REMOTE_CACHE'" > "$OUT" 2>/dev/null
    if [ ! -s "$OUT" ]; then
        $ADB shell "su -c 'cat $REMOTE_TMP'" > "$OUT" 2>/dev/null
    fi
    if [ ! -s "$OUT" ]; then
        $ADB shell "su -c 'cat $REMOTE_OLD'" > "$OUT" 2>/dev/null
    fi
    if [ ! -s "$OUT" ]; then
        rm -f "$OUT"
        error "拉取失败或文件为空\n  已尝试:\n    $REMOTE_CACHE\n    $REMOTE_TMP\n    $REMOTE_OLD"
    fi
    info "已保存: $OUT ($(du -h "$OUT" | cut -f1))"
    DEC="$SCRIPT_DIR/tools/trace_decode.py"
    if [ -f "$DEC" ]; then
        info "解码 (前 200 条; 完整用 python3 tools/trace_decode.py $OUT):"
        python3 "$DEC" "$OUT" --limit 200 || true
    else
        warn "缺少 tools/trace_decode.py, 跳过解码"
    fi
    exit 0
fi

# ===== Trace 模式: 生成自包含 QBDI trace 脚本 =====
if [ "$TRACE_MODE" = true ]; then
    PACKAGE="$1"
    TRACE_LIB="$2"
    TRACE_TARGET="$3"
    [ -z "$PACKAGE" ] || [ -z "$TRACE_LIB" ] || [ -z "$TRACE_TARGET" ] && \
        error "用法: $0 --trace <包名> <lib名> <偏移或符号>"
    [ -f "$SCRIPT_DIR/scripts/qbdi.js" ] || error "缺少 scripts/qbdi.js"

    GEN="$SCRIPT_DIR/.kfm_qbdi_trace.js"
    REC=$([ "$RECORD_MEM" = true ] && echo "true" || echo "false")
    OUTDIR="/data/data/$PACKAGE/cache/qbdi_trace"
    $ADB shell "su -c 'mkdir -p $OUTDIR && chmod 777 $OUTDIR'" 2>/dev/null || true
    {
        cat "$SCRIPT_DIR/scripts/qbdi.js"
        cat <<EOF

// ===== 自动生成的 trace 入口 (run.sh --trace) =====
(function () {
    var LIB = "$TRACE_LIB";
    var TGT = "$TRACE_TARGET";
    function findMod(n) {
        try { if (typeof Process !== 'undefined' && Process.findModuleByName) return Process.findModuleByName(n); } catch (e) {}
        try { if (typeof Module !== 'undefined' && Module.findModuleByName) return Module.findModuleByName(n); } catch (e) {}
        return null;
    }
    var m = findMod(LIB);
    if (!m) { console.log('[trace] 未找到模块 ' + LIB); return; }
    var target;
    if (TGT.indexOf('0x') === 0) target = m.base.add(parseInt(TGT, 16));
    else if (/^[0-9]+$/.test(TGT)) target = m.base.add(parseInt(TGT, 10));
    else { target = Module.findExportByName(LIB, TGT); }
    if (!target) { console.log('[trace] 解析目标失败: ' + TGT); return; }
    console.log('[trace] target=' + target + ' (' + LIB + '!' + TGT + ')');
    // target 必须是可执行地址; outputDir 用应用私有目录 (attach 模式必须显式传)
    if (!Qbdi.setupTrace(target, "$OUTDIR")) return;
    Qbdi.hookWithQbdi(target);
    console.log('[trace] 触发目标逻辑后, trace 落在 $OUTDIR/trace_bundle.pb');
})();
EOF
    } > "$GEN"

    HOOK_SCRIPT=".kfm_qbdi_trace.js"
    info "已生成 trace 脚本: $TRACE_LIB!$TRACE_TARGET (record_mem=$REC)"
    info "trace 输出: $OUTDIR/trace_bundle.pb"
    info "触发后拉取+解码: ./run.sh --pull-trace $PACKAGE"
    # 强制重新推送生成脚本
    $ADB shell "rm -f $REMOTE_SCRIPT_DIR/$HOOK_SCRIPT" 2>/dev/null || true
fi

PACKAGE="${PACKAGE:-${1:-com.zhiliaoapp.musically}}"
[ "$TRACE_MODE" = true ] || HOOK_SCRIPT="${2:-$DEFAULT_HOOK}"

# 检查设备
$ADB shell echo ok >/dev/null 2>&1 || error "设备未连接"
MODEL=$($ADB shell getprop ro.product.model | tr -d '\r')
info "设备: $MODEL"

# 检查二进制
$ADB shell "[ -x $REMOTE_BIN ]" 2>/dev/null || error "rustfrida 未部署，请先运行 ./deploy.sh"

# 检查 hook 脚本
REMOTE_HOOK="$REMOTE_SCRIPT_DIR/$HOOK_SCRIPT"
$ADB shell "[ -f $REMOTE_HOOK ]" 2>/dev/null || {
    if [ -f "$SCRIPT_DIR/$HOOK_SCRIPT" ]; then
        info "推送 $HOOK_SCRIPT..."
        $ADB push "$SCRIPT_DIR/$HOOK_SCRIPT" "$REMOTE_HOOK" >/dev/null
    else
        error "找不到 hook 脚本: $HOOK_SCRIPT"
    fi
}

# 杀掉旧 rustfrida
OLD_PID=$($ADB shell "pidof rustfrida" 2>/dev/null | tr -d '\r')
[ -n "$OLD_PID" ] && {
    warn "杀掉旧进程 PID=$OLD_PID"
    $ADB shell "su -c 'kill -9 $OLD_PID'" 2>/dev/null || true
    sleep 1
}

if [ "$SPAWN_MODE" = true ]; then
    # ===== Spawn 模式 =====
    info "Spawn 模式: $PACKAGE"
    info "脚本: $HOOK_SCRIPT"
    echo ""

    if [ "$BG_MODE" = true ]; then
        # 后台运行: 用 FIFO 保持 stdin 打开
        $ADB shell "su -c '
            rm -f /data/local/tmp/.rf_pipe
            mkfifo /data/local/tmp/.rf_pipe
            sleep 999999 > /data/local/tmp/.rf_pipe &
            echo \$! > /data/local/tmp/.rf_sleep_pid
            nohup $REMOTE_BIN --spawn $PACKAGE -l $REMOTE_HOOK < /data/local/tmp/.rf_pipe > /data/local/tmp/rustfrida.log 2>&1 &
            RF_PID=\$!
            echo \$RF_PID > /data/local/tmp/.rf_pid
            echo \"[+] rustfrida 后台运行 PID=\$RF_PID\"
            echo \"[+] 日志: adb shell cat /data/local/tmp/rustfrida.log\"
            echo \"[+] 停止: adb shell su -c \\\"kill -9 \$RF_PID\\\"\"
        '"
    else
        # 前台运行: 用 sleep 保持 stdin, Ctrl+C 退出
        info "按 Ctrl+C 停止"
        # 用 sleep pipe 保持 rustfrida 运行
        $ADB shell "su -c 'sleep 999999 | $REMOTE_BIN --spawn $PACKAGE -l $REMOTE_HOOK'" || true
    fi
else
    # ===== Attach 模式 =====
    TARGET_PID=$($ADB shell "pidof $PACKAGE" 2>/dev/null | tr -d '\r' | awk '{print $1}')
    if [ -z "$TARGET_PID" ]; then
        info "启动 $PACKAGE..."
        $ADB shell "monkey -p $PACKAGE -c android.intent.category.LAUNCHER 1" >/dev/null 2>&1
        sleep 3
        TARGET_PID=$($ADB shell "pidof $PACKAGE" 2>/dev/null | tr -d '\r' | awk '{print $1}')
        [ -z "$TARGET_PID" ] && error "$PACKAGE 未运行"
    fi

    info "目标: $PACKAGE (PID: $TARGET_PID)"
    info "脚本: $HOOK_SCRIPT"
    echo ""

    if [ "$BG_MODE" = true ]; then
        # 后台运行
        $ADB shell "su -c '
            rm -f /data/local/tmp/.rf_pipe
            mkfifo /data/local/tmp/.rf_pipe
            sleep 999999 > /data/local/tmp/.rf_pipe &
            echo \$! > /data/local/tmp/.rf_sleep_pid
            nohup $REMOTE_BIN -p $TARGET_PID -l $REMOTE_HOOK < /data/local/tmp/.rf_pipe > /data/local/tmp/rustfrida.log 2>&1 &
            RF_PID=\$!
            echo \$RF_PID > /data/local/tmp/.rf_pid
            echo \"[+] rustfrida 后台运行 PID=\$RF_PID\"
            echo \"[+] 日志: adb shell cat /data/local/tmp/rustfrida.log\"
            echo \"[+] 停止: adb shell su -c \\\"kill -9 \$RF_PID\\\"\"
        '"
    else
        # 前台运行
        info "按 Ctrl+C 停止"
        $ADB shell "su -c 'sleep 999999 | $REMOTE_BIN -p $TARGET_PID -l $REMOTE_HOOK'" || true
    fi
fi
