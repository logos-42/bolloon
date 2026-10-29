//! 薄入口: 真正的实现与移动端入口在 lib.rs (`bolloon_tauri_lib::run`)。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    bolloon_tauri_lib::run()
}
