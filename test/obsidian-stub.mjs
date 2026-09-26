// テスト用の最小 obsidian スタブ / minimal obsidian stub for tests
export class App {}
export class TFile {}
export class TFolder {}
export function normalizePath(p) {
  return p;
}
// タグ取得スタブ（collectTasks はテストで未使用）/ tag stub (collectTasks isn't exercised in tests)
export function getAllTags() {
  return null;
}
// 列定義（columns.ts）が参照する UI 部品のスタブ。テストでは描画しない
// stubs for UI helpers columns.ts imports; tests never paint
export function setIcon() {}
export const moment = { locale: () => "en" };
// wikilink UI（linkui.ts）が参照する API のスタブ / stubs for the APIs linkui.ts imports
export class Component {}
export const Keymap = { isModEvent: () => false };
export function prepareFuzzySearch() {
  return () => null;
}
