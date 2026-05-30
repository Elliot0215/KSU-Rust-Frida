// ===== grab1.js =====
/**
 * Grab App 更新绕过专用脚本 — rustfrida 兼容版
 */
'use strict';
if (typeof Java !== 'undefined' && typeof Java.perform === 'undefined' && typeof Java.ready === 'function') {
    Java.perform = Java.ready;
}

console.log("╔════════════════════════════════════════════════════════════╗");
console.log("║   Grab App 更新绕过专用脚本 v1.0 (rustfrida)            ║");
console.log("╚════════════════════════════════════════════════════════════╝\n");

Java.perform(function() {
    console.log("[*] 开始更新绕过...\n");
    
    // 1. AlertDialog 拦截
    try {
        var AlertDialog = Java.use("android.app.AlertDialog");
        AlertDialog.show.impl = function() {
            try {
                var title = this.getTitle();
                var message = this.getMessage();
                var titleStr = title ? title.toString() : "";
                var messageStr = message ? message.toString() : "";
                
                console.log("[!] AlertDialog - Title: " + titleStr);
                
                if (/更新|升级|update|upgrade/i.test(titleStr + messageStr)) {
                    console.log("[!] 拦截更新对话框");
                    return;
                }
            } catch(e) {}
            return this.$orig();
        };
        console.log("[✓] AlertDialog 拦截已启用");
    } catch(e) {
        console.log("[-] AlertDialog 拦截失败: " + e);
    }
    
    // 2. System.exit 拦截
    try {
        var Sys = Java.use("java.lang.System");
        Sys.exit.impl = function(code) {
            console.log("[!] System.exit(" + code + ") 被拦截");
        };
        console.log("[✓] System.exit 拦截已启用");
    } catch(e) {}
    
    // 3. Process.killProcess 拦截
    try {
        var Proc = Java.use("android.os.Process");
        Proc.killProcess.impl = function(pid) {
            console.log("[!] killProcess(" + pid + ") 被拦截");
        };
        console.log("[✓] killProcess 拦截已启用");
    } catch(e) {}
    
    // 4. Activity.finish 拦截（更新导致的退出）
    try {
        var Activity = Java.use("android.app.Activity");
        Activity.finish.overload().impl = function() {
            var activityName = this.getClass().getName();
            console.log("[*] Activity.finish(): " + activityName);
            // 放行非更新相关的 finish
            return this.$orig();
        };
        console.log("[✓] Activity.finish 监控已启用");
    } catch(e) {}
    
    console.log("\n[✓] 更新绕过已完成");
});

// ===== grab2.js =====
/**
 * Grab App SSL Pinning 绕过专用脚本 — rustfrida 兼容版
 */
'use strict';
if (typeof Java !== 'undefined' && typeof Java.perform === 'undefined' && typeof Java.ready === 'function') {
    Java.perform = Java.ready;
}

console.log("╔════════════════════════════════════════════════════════════╗");
console.log("║   Grab App SSL Pinning 绕过专用脚本 v1.0 (rustfrida)    ║");
console.log("╚════════════════════════════════════════════════════════════╝\n");

// ==================== Native 层绕过 ====================
console.log("[阶段 1] Native 层 SSL Pinning 绕过");
console.log("============================================================");

// 1. mbedTLS SSL Pinning 绕过 (libpsec.so)
try {
    var libpsec = Process.findModuleByName("libpsec.so");
    if (libpsec) {
        console.log("[+] 找到 libpsec.so");
        var x509Verify = libpsec.base.add(0xAC690);
        Interceptor.attach(x509Verify, {
            onEnter: function(args) {
                this.flagsPtr = args[5];
            },
            onLeave: function(retval) {
                if (this.flagsPtr) {
                    this.flagsPtr.writeU32(0);
                }
                retval.replace(0);
            }
        });
        console.log("[✓] mbedTLS SSL Pinning 已绕过");
    }
} catch(e) {
    console.log("[-] mbedTLS 绕过失败: " + e);
}

// 2. V-Key VGuard 绕过 (libchecks.so)
try {
    var libchecks = Process.findModuleByName("libchecks.so");
    if (libchecks) {
        console.log("[+] 找到 libchecks.so");
        var functions = [
            "Java_com_vkey_android_internal_vguard_engine_NativeThreatsChecker_checkForSuFilesNative",
            "Java_com_vkey_android_internal_vguard_engine_NativeThreatsChecker_checkForVncSshTelnet",
            "Java_com_vkey_android_internal_vguard_engine_NativeThreatsChecker_findSuidSgidFiles",
            "Java_com_vkey_android_internal_vguard_engine_NativeThreatsChecker_listPortUsing",
            "Java_com_vkey_android_internal_vguard_engine_checks_FuncPtrCheck_validateFunctionPointer",
            "scan_root",
            "scan_root_func"
        ];
        var hookedCount = 0;
        functions.forEach(function(funcName) {
            try {
                var funcPtr = Module.findExportByName("libchecks.so", funcName);
                if (funcPtr) {
                    Interceptor.attach(funcPtr, {
                        onLeave: function(retval) { retval.replace(ptr(0)); }
                    });
                    hookedCount++;
                }
            } catch(e) {}
        });
        console.log("[✓] V-Key VGuard 已绕过 (" + hookedCount + " 个函数)");
    }
} catch(e) {
    console.log("[-] V-Key VGuard 绕过失败: " + e);
}

// 3. 系统调用拦截
try {
    var accessPtr = Module.findExportByName(null, "access");
    if (accessPtr) {
        Interceptor.attach(accessPtr, {
            onEnter: function(args) {
                try {
                    var path = Memory.readUtf8String(args[0]);
                    if (path && /su|magisk|frida/.test(path)) {
                        this.block = true;
                    }
                } catch(e) {}
            },
            onLeave: function(retval) {
                if (this.block) retval.replace(-1);
            }
        });
        console.log("[✓] access() 已 Hook");
    }
} catch(e) {}

console.log("[✓] Native 层绕过完成\n");

// ==================== Java 层绕过 ====================
Java.perform(function() {
    console.log("[阶段 2] Java 层 SSL Pinning 绕过");
    console.log("============================================================");
    
    console.log("\n[子阶段 2.1] SSL Pinning 绕过");
    
    // OkHttp CertificatePinner 绕过
    try {
        var CertificatePinner = Java.use("okhttp3.CertificatePinner");
        var ArrayList = Java.use("java.util.ArrayList");
        
        try {
            CertificatePinner.c.impl = function(hostname) {
                console.log("[+] 绕过 CertificatePinner.c(): " + hostname);
                return ArrayList.$new();
            };
        } catch(e) {}
        
        try {
            CertificatePinner.a.overload('java.lang.String', 'java.util.List').impl = function(hostname, peerCerts) {
                console.log("[+] 绕过 CertificatePinner.a(): " + hostname);
            };
        } catch(e) {}
        
        try {
            CertificatePinner.b.overload('java.lang.String', 'kotlin.jvm.functions.Function0').impl = function(hostname, cleanedPeerCertsFn) {
                console.log("[+] 绕过 CertificatePinner.b(): " + hostname);
            };
        } catch(e) {}
        
        console.log("[✓] OkHttp SSL Pinning 已绕过");
    } catch(e) {
        console.log("[-] OkHttp SSL Pinning 绕过失败: " + e);
    }
    
    // TrustManagerImpl (Conscrypt) — 直接 hook 验证方法, 不用 registerClass
    try {
        var TrustManagerImpl = Java.use('com.android.org.conscrypt.TrustManagerImpl');
        TrustManagerImpl.verifyChain.impl = function() {
            var host = '?';
            try { host = arguments[2]; } catch(e) {}
            console.log("[+] 绕过 verifyChain: " + host);
            return arguments[0];
        };
        console.log("[✓] TrustManagerImpl 已绕过");
    } catch(e) {
        console.log("[-] TrustManagerImpl 绕过失败: " + e);
    }
    
    // SSLContext.init — 通用兜底
    try {
        var SSLContext = Java.use('javax.net.ssl.SSLContext');
        SSLContext.init.overload('[Ljavax.net.ssl.KeyManager;', '[Ljavax.net.ssl.TrustManager;', 'java.security.SecureRandom').impl = function(km, tm, sr) {
            console.log("[+] SSLContext.init 绕过");
            return this.$orig(km, null, sr);
        };
        console.log("[✓] SSLContext.init 已绕过");
    } catch(e) {}
    
    // 网络请求监控
    console.log("\n[子阶段 2.2] 网络请求监控");
    try {
        var URL = Java.use("java.net.URL");
        URL.openConnection.overload().impl = function() {
            var url = this.toString();
            if (/api\.grab\.com|p\.grabtaxi\.com|portal\.grab\.com/.test(url)) {
                console.log("\n[→] Grab API 请求: " + url);
            }
            return this.$orig();
        };
        console.log("[✓] 网络监控已启动");
    } catch(e) {}
    
    console.log("\n============================================================");
    console.log("[✓] SSL Pinning 绕过完成");
    console.log("============================================================");
    console.log("\n[*] 提示:");
    console.log("  1. SSL Pinning 已绕过，可以在 Charles/Burp 中查看 HTTPS 流量");
    console.log("  2. 网络请求会被监控");
    console.log("  3. 现在可以正常抓包了！\n");
});

