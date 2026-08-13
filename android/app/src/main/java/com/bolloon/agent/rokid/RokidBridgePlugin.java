package com.bolloon.agent.rokid;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import androidx.annotation.Nullable;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.rokid.cxr.CXRServiceBridge;
import com.rokid.cxr.Caps;
import com.rokid.cxr.client.controllers.CxrController;
import com.rokid.cxr.client.utils.ValueUtil;

import java.util.Set;
import java.util.UUID;

/**
 * Rokid 手机—眼镜桥 (真实 CXR-M SDK, 无 mock)。
 *
 * 通道模型:
 *   1. 蓝牙: CxrController (单例门面) initBluetooth + connectBluetooth 连接 Rokid 眼镜
 *      (BLE GATT / 经典 BT Socket, 由 SDK 内部选择)。
 *   2. 消息: CXRServiceBridge (native) pub/sub — Bolloon 协议层 topic:
 *      - "bolloon.message"      手机 → 眼镜 (AI 回复/用户消息)
 *      - "bolloon.notification" 手机 → 眼镜 (通知)
 *      眼镜端 app 订阅同一 topic (Bolloon 自有协议, 走 CXR 真实通道)。
 *
 * 注意: CXR SDK 只发 arm64-v8a / armeabi-v7a JNI .so (无 x86_64), 静态块即
 * System.loadLibrary("cxr-bridge-jni") → x86_64 模拟器上抛 UnsatisfiedLinkError。
 * 真机 (arm64) 正常; 模拟器上 connect() 返回错误, UI 渲染不受影响。
 */
@CapacitorPlugin(
        name = "RokidBridge",
        permissions = {
                @Permission(alias = "bluetooth", strings = {
                        Manifest.permission.BLUETOOTH_CONNECT,
                        Manifest.permission.BLUETOOTH_SCAN,
                        Manifest.permission.ACCESS_FINE_LOCATION
                })
        })
public class RokidBridgePlugin extends Plugin {

    private static final String TAG = "RokidBridge";
    private static final String TOPIC_MESSAGE = "bolloon.message";
    private static final String TOPIC_NOTIFICATION = "bolloon.notification";

    private final RealRokidAdapter adapter = new RealRokidAdapter();
    private volatile boolean nativeAvailable;

    @Override
    public void load() {
        adapter.setListener(event -> notifyListeners("rokidEvent", event));
        // 探测 CXR native 库 (静态块 loadLibrary) 是否可加载; 真机可用, x86_64 模拟器不可用。
        try {
            Class.forName("com.rokid.cxr.CXRServiceBridge");
            nativeAvailable = true;
        } catch (Throwable t) {
            nativeAvailable = false;
            Log.w(TAG, "CXR native unavailable on this ABI: " + t);
        }
    }

    @PluginMethod
    public void connect(PluginCall call) {
        if (!nativeAvailable) {
            JSObject result = new JSObject();
            result.put("ok", false);
            result.put("mode", "real");
            result.put("error", "CXR native lib unavailable on this ABI (x86_64 emulator); use an arm64 device");
            call.resolve(result);
            return;
        }
        if (!hasBluetoothPermission()) {
            requestPermissionForAlias("bluetooth", call, "connect");
            return;
        }
        try {
            adapter.connect(getContext());
            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("mode", "real");
            result.put("deviceId", adapter.deviceId());
            call.resolve(result);
        } catch (Throwable t) {
            Log.e(TAG, "connect failed", t);
            call.reject("connect failed: " + t.getMessage());
        }
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        try {
            adapter.disconnect();
            call.resolve();
        } catch (Throwable t) {
            call.reject("disconnect failed: " + t.getMessage());
        }
    }

    @PluginMethod
    public void sendMessage(PluginCall call) {
        String text = call.getString("text", "").trim();
        if (text.isEmpty()) {
            call.reject("text is required");
            return;
        }
        try {
            adapter.sendMessage(text, call.getString("channelId", null));
            call.resolve();
        } catch (Throwable t) {
            call.reject("send failed: " + t.getMessage());
        }
    }

    @PluginMethod
    public void sendNotification(PluginCall call) {
        String title = call.getString("title", "Bolloon");
        String body = call.getString("body", "");
        if (body.trim().isEmpty()) {
            call.reject("body is required");
            return;
        }
        try {
            adapter.sendNotification(title, body);
            call.resolve();
        } catch (Throwable t) {
            call.reject("send failed: " + t.getMessage());
        }
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject result = adapter.status();
        result.put("mode", "real");
        result.put("nativeAvailable", nativeAvailable);
        call.resolve(result);
    }

    private boolean hasBluetoothPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return true;
        }
        return getActivity().checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT)
                == PackageManager.PERMISSION_GRANTED;
    }

    // ────────────────────────────────────────────────────────────
    // 真实 CXR-M SDK Adapter (无 mock 分支)
    // ────────────────────────────────────────────────────────────
    private static final class RealRokidAdapter {

        interface Listener {
            void onEvent(JSObject event);
        }

        private Listener listener;
        private CXRServiceBridge bridge;
        private CxrController controller;
        private volatile boolean connected;
        private volatile String deviceId = "unknown";

        void setListener(Listener listener) {
            this.listener = listener;
        }

        void connect(Context ctx) {
            // 1) CXR 消息桥 (native; 类加载即 loadLibrary("cxr-bridge-jni"), 仅 arm 真机可用)
            bridge = new CXRServiceBridge();
            bridge.setStatusListener(new CXRServiceBridge.StatusListener() {
                @Override
                public void onConnected(String id, String name, int type) {
                    connected = true;
                    deviceId = id != null ? id : deviceId;
                    emit(evt("connected").put("device", deviceId).put("name", name == null ? "" : name).put("type", type));
                }

                @Override
                public void onDisconnected() {
                    connected = false;
                    emit(evt("disconnected").put("reason", "device-disconnected"));
                }

                @Override
                public void onConnecting(String id, String name, int type) {
                    emit(evt("connecting").put("device", id == null ? "" : id).put("name", name == null ? "" : name));
                }

                @Override
                public void onARTCStatus(float quality, boolean ok) {
                    emit(evt("artcStatus").put("quality", quality).put("ok", ok));
                }

                @Override
                public void onRokidAccountChanged(String account) {
                    emit(evt("accountChanged").put("account", account == null ? "" : account));
                }

                @Override
                public void onAudioNoise(float db) {
                    // 音频噪声电平, 桥接层不消费
                }
            });

            // 订阅 眼镜 → 手机 消息 (Bolloon 协议 topic)
            bridge.subscribe(TOPIC_MESSAGE, (topic, caps, payload) -> {
                JSObject event = evt("message");
                event.put("id", UUID.randomUUID().toString());
                event.put("text", caps != null ? caps.toString() : "");
                event.put("source", "glass");
                event.put("topic", topic);
                emit(event);
            });
            bridge.subscribe(TOPIC_NOTIFICATION, (topic, caps, payload) -> {
                JSObject event = evt("notification");
                event.put("id", UUID.randomUUID().toString());
                event.put("text", caps != null ? caps.toString() : "");
                event.put("source", "glass");
                emit(event);
            });

            // 2) 蓝牙连接门面: 从已配对设备里找 Rokid 眼镜
            controller = CxrController.getInstance();
            controller.setCallback(new CxrController.Callback() {
                @Override
                public void onConnectionInfo(String deviceId, String name, String address, int state) {
                    emit(evt("connectionInfo")
                            .put("device", deviceId == null ? "" : deviceId)
                            .put("name", name == null ? "" : name)
                            .put("address", address == null ? "" : address)
                            .put("state", state));
                }

                @Override
                public void onStatusUpdate(ValueUtil.CxrStatus status, ValueUtil.CxrBluetoothErrorCode errorCode) {
                    emit(evt("btStatus").put("status", String.valueOf(status))
                            .put("errorCode", String.valueOf(errorCode)));
                }

                @Override
                public void onStatusUpdateWithExtra(ValueUtil.CxrStatus status, ValueUtil.CxrBluetoothErrorCode errorCode, String extra1, String extra2) {
                    emit(evt("btStatus").put("status", String.valueOf(status))
                            .put("errorCode", String.valueOf(errorCode))
                            .put("extra1", extra1 == null ? "" : extra1)
                            .put("extra2", extra2 == null ? "" : extra2));
                }

                @Override
                public void onValueUpdate(String key, Caps value) {
                    emit(evt("valueUpdate").put("key", key == null ? "" : key)
                            .put("value", value == null ? "" : value.toString()));
                }

                @Override
                public void onStartAudioStream(int streamId, int sampleRate, int channels, String format, Caps param) {
                    // 音频流事件, 桥接层透传 (可选消费)
                }

                @Override
                public void onAudioStream(int streamId, byte[] data, int offset, int length) {
                }

                @Override
                public void onAudioStreamFinish(int streamId) {
                }

                @Override
                public void onARTCFrame(byte[] frame, long timestamp) {
                }

                @Override
                public void onBtClientsInfo(java.util.List<ValueUtil.BtClientInfo> clients) {
                    emit(evt("btClients").put("count", clients == null ? 0 : clients.size()));
                }
            });

            BluetoothDevice device = findRokidDevice();
            if (device == null) {
                emit(evt("error").put("message",
                        "未找到已配对的 Rokid 眼镜: 请先在系统蓝牙设置里配对, 或检查眼镜端 app 已启动"));
                return;
            }
            deviceId = device.getAddress();
            controller.initBluetooth(ctx, device);
            controller.connectBluetooth(ctx, device.getName(), device.getAddress(), device.getName());
        }

        void disconnect() {
            if (bridge != null) {
                try {
                    bridge.disconnectCXRDevice();
                } catch (Throwable t) {
                    Log.w(TAG, "disconnectCXRDevice", t);
                }
                bridge = null;
            }
            if (controller != null && controller.isBluetoothConnected()) {
                try {
                    controller.clearCommunicationDevice();
                } catch (Throwable t) {
                    Log.w(TAG, "clearCommunicationDevice", t);
                }
            }
            connected = false;
            emit(evt("disconnected").put("reason", "client-disconnect"));
        }

        void sendMessage(String text, @Nullable String channelId) {
            ensureBridge();
            Caps caps = new Caps();
            caps.write(text);
            if (channelId != null) {
                caps.write(channelId);
            }
            int rc = bridge.sendMessage(TOPIC_MESSAGE, caps);
            if (rc != 0) {
                emit(evt("sendStatus").put("ok", false).put("error", "rc=" + rc));
            }
        }

        void sendNotification(String title, String body) {
            ensureBridge();
            Caps caps = new Caps();
            caps.write(title);
            caps.write(body);
            int rc = bridge.sendMessage(TOPIC_NOTIFICATION, caps);
            if (rc != 0) {
                emit(evt("sendStatus").put("ok", false).put("error", "rc=" + rc));
            }
        }

        JSObject status() {
            boolean btConnected = controller != null && controller.isBluetoothConnected();
            JSObject status = new JSObject();
            status.put("id", deviceId);
            status.put("model", "Rokid Glasses (CXR-M)");
            status.put("connected", connected);
            status.put("btConnected", btConnected);
            status.put("capabilities", new String[]{"messages", "notifications", "device-state"});
            return status;
        }

        String deviceId() {
            return deviceId;
        }

        private void ensureBridge() {
            if (bridge == null) {
                bridge = new CXRServiceBridge();
            }
        }

        private BluetoothDevice findRokidDevice() {
            BluetoothAdapter adapter = BluetoothAdapter.getDefaultAdapter();
            if (adapter == null) {
                return null;
            }
            Set<BluetoothDevice> bonded = adapter.getBondedDevices();
            if (bonded == null) {
                return null;
            }
            for (BluetoothDevice device : bonded) {
                String name = device.getName();
                if (name != null) {
                    String lower = name.toLowerCase();
                    if (lower.contains("rokid") || lower.contains("glass") || lower.contains("ar studio")) {
                        return device;
                    }
                }
            }
            return bonded.isEmpty() ? null : bonded.iterator().next();
        }

        private void emit(JSObject event) {
            if (listener != null) {
                listener.onEvent(event);
            }
        }

        private static JSObject evt(String type) {
            JSObject event = new JSObject();
            event.put("type", type);
            return event;
        }
    }

    // ============ Android Agent Runtime (Phase 1) ============
    // 2026-08-12: 暴露给 webview UI — runAgent(goal) 执行 Agent 任务 (Observe→Think→Act)

    /** 查询 Agent 状态 (无障碍服务是否连接 / LLM 配置 / 生命周期状态) */
    @PluginMethod
    public void agentStatus(PluginCall call) {
        JSObject r = new JSObject();
        r.put("accessibilityReady", AgentRuntimeHolder.INSTANCE.isAccessibilityReady());
        r.put("model", AgentRuntimeHolder.INSTANCE.getLlmConfig().getModel());
        r.put("baseUrl", AgentRuntimeHolder.INSTANCE.getLlmConfig().getBaseUrl());
        // Phase 4: 生命周期状态
        try {
            r.put("lifecycle", new JSObject(AgentRuntimeHolder.INSTANCE.agentStatusJson()));
        } catch (Exception e) {
            r.put("lifecycle", "parse-error");
        }
        call.resolve(r);
    }

    /** Phase 4: 请求取消当前 Agent 任务 (两段式取消) */
    @PluginMethod
    public void cancelAgent(PluginCall call) {
        boolean ok = AgentRuntimeHolder.INSTANCE.cancelAgent("user cancel");
        call.resolve(new JSObject().put("cancelRequested", ok));
    }

    // ============ 宏录制/重放 (2026-08-13, 借鉴 Ghost MacroRecorder) ============

    /** 宏: action = start|stop|tap|swipe|type|back|home|wait|replay|to_json|from_json */
    @PluginMethod
    public void macro(PluginCall call) {
        String action = call.getString("action");
        if (action == null) { call.reject("action 必填 (start/stop/tap/swipe/type/back/home/wait/replay/to_json/from_json)"); return; }
        MacroRecorder rec = AgentRuntimeHolder.INSTANCE.macroRecorder();
        if (rec == null) { call.reject("无障碍服务未连接"); return; }
        try {
            switch (action) {
                case "start": rec.start(); call.resolve(new JSObject().put("ok", true)); break;
                case "stop": {
                    MacroRecorder.Macro m = rec.stop();
                    call.resolve(new JSObject().put("steps", m.getSteps().size()).put("duration", m.getDuration()));
                    break;
                }
                case "tap": rec.tap(call.getInt("x", 0), call.getInt("y", 0)); call.resolve(new JSObject().put("ok", true)); break;
                case "back": rec.back(); call.resolve(new JSObject().put("ok", true)); break;
                case "home": rec.home(); call.resolve(new JSObject().put("ok", true)); break;
                case "type": rec.type(call.getString("text", "")); call.resolve(new JSObject().put("ok", true)); break;
                case "replay": {
                    String json = call.getString("json");
                    if (json == null || json.isEmpty()) { call.reject("replay 需要 json (宏 JSON)"); return; }
                    MacroRecorder.Macro m = rec.fromJson(json);
                    Double spd = call.getDouble("speed", 1.0);
                    String log = rec.replay(m, spd.floatValue());
                    call.resolve(new JSObject().put("log", log));
                    break;
                }
                default: call.reject("未知 action: " + action);
            }
        } catch (Exception e) {
            call.reject("macro 失败: " + e.getMessage());
        }
    }

    /** 配置 LLM (baseUrl/apiKey/model) */
    @PluginMethod
    public void agentConfigure(PluginCall call) {
        String baseUrl = call.getString("baseUrl");
        String apiKey = call.getString("apiKey");
        String model = call.getString("model");
        AgentLlmConfig cfg = new AgentLlmConfig(
            baseUrl != null && !baseUrl.isEmpty() ? baseUrl : "https://api.deepseek.com/v1",
            apiKey != null ? apiKey : "",
            model != null && !model.isEmpty() ? model : "deepseek-chat",
            4096
        );
        AgentRuntimeHolder.INSTANCE.configureLlm(cfg);
        call.resolve(new JSObject().put("ok", true));
    }

    /** 运行 Agent 任务: goal 用户目标, onStep 每步回调 (SSE 事件给 webview), onDone 完成 */
    @PluginMethod
    public void runAgent(PluginCall call) {
        String goal = call.getString("goal");
        if (goal == null || goal.trim().isEmpty()) {
            call.reject("goal 必填");
            return;
        }
        call.setKeepAlive(true);
        final PluginCall finalCall = call;
        AgentRuntimeHolder.INSTANCE.runAgent(goal.trim(),
            (String step) -> {
                JSObject ev = new JSObject();
                ev.put("type", "agent-step");
                ev.put("step", step);
                notifyListeners("agent-step", ev);
                return kotlin.Unit.INSTANCE;
            },
            (String done) -> {
                JSObject r = new JSObject();
                r.put("result", done);
                finalCall.resolve(r);
                return kotlin.Unit.INSTANCE;
            }
        );
    }
}
