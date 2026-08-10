package com.bolloon.agent.rokid;

import androidx.annotation.Nullable;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.UUID;

@CapacitorPlugin(name = "RokidBridge")
public class RokidBridgePlugin extends Plugin {
    private final MockRokidAdapter adapter = new MockRokidAdapter();

    @Override
    public void load() {
        adapter.setListener(event -> notifyListeners("rokidEvent", event));
    }

    @PluginMethod
    public void connect(PluginCall call) {
        adapter.connect();
        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("mode", BuildConfig.ROKID_SDK_MODE);
        result.put("deviceId", adapter.deviceId());
        call.resolve(result);
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        adapter.disconnect();
        call.resolve();
    }

    @PluginMethod
    public void sendMessage(PluginCall call) {
        String text = call.getString("text", "").trim();
        if (text.isEmpty()) {
            call.reject("text is required");
            return;
        }
        adapter.sendMessage(text, call.getString("channelId", null));
        call.resolve();
    }

    @PluginMethod
    public void sendNotification(PluginCall call) {
        String title = call.getString("title", "Bolloon");
        String body = call.getString("body", "");
        if (body.trim().isEmpty()) {
            call.reject("body is required");
            return;
        }
        adapter.sendNotification(title, body);
        call.resolve();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject result = adapter.status();
        result.put("mode", BuildConfig.ROKID_SDK_MODE);
        call.resolve(result);
    }

    private static final class MockRokidAdapter {
        interface Listener { void onEvent(JSObject event); }

        private Listener listener;
        private boolean connected;

        void setListener(Listener listener) { this.listener = listener; }

        void connect() {
            connected = true;
            JSObject event = new JSObject();
            event.put("type", "connected");
            event.put("device", status());
            emit(event);
        }

        void disconnect() {
            connected = false;
            JSObject event = new JSObject();
            event.put("type", "disconnected");
            event.put("reason", "client-disconnect");
            emit(event);
        }

        void sendMessage(String text, @Nullable String channelId) {
            JSObject event = new JSObject();
            event.put("type", "message");
            event.put("id", UUID.randomUUID().toString());
            event.put("text", text);
            event.put("source", "phone");
            if (channelId != null) event.put("channelId", channelId);
            emit(event);
        }

        void sendNotification(String title, String body) {
            JSObject event = new JSObject();
            event.put("type", "notification");
            event.put("title", title);
            event.put("body", body);
            emit(event);
        }

        JSObject status() {
            JSObject status = new JSObject();
            status.put("id", "mock-rokid-glasses");
            status.put("model", "Rokid Glass Mock");
            status.put("connected", connected);
            status.put("capabilities", new String[]{"messages", "notifications", "device-state"});
            return status;
        }

        private void emit(JSObject event) { if (listener != null) listener.onEvent(event); }
        private String deviceId() { return "mock-rokid-glasses"; }
    }
}
