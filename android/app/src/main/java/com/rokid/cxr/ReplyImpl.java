package com.rokid.cxr;

/**
 * Rokid client-m AAR 发布缺陷补丁。
 *
 * 官方 `com.rokid.cxr:client-m` (1.2.2 及更早所有版本) 的 native 库 libcxr-bridge-jni.so
 * 在 JNI_OnLoad 里 FindClass("com/rokid/cxr/ReplyImpl"), 但 AAR 的 classes.jar 并不含该类
 * (发布管线 R8 混淆事故)。缺该类时 ART 直接 JNI abort (SIGABRT) 杀掉进程。
 *
 * 本类补齐该缺失类: 实现 CXRServiceBridge.Reply (native 构造后回调 end(Caps)),
 * 并声明 native 侧注册的 nativeEnd 方法。签名依据 .so 字符串表:
 *   nativeEnd + (JLcom/rokid/cxr/Caps;)V
 * 若官方修复 AAR 后此补丁与 SDK 冲突, 删除本文件即可。
 */
public class ReplyImpl implements CXRServiceBridge.Reply {

    private long nativePtr;

    public ReplyImpl() {
    }

    private native void nativeEnd(long ptr, Caps caps);

    private native void nativeReleaseData(long ptr);

    @Override
    public void end(Caps caps) {
        nativeEnd(nativePtr, caps);
    }
}
