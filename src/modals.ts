// 破壊的操作の前に挟む確認ダイアログ。ビューと設定画面の両方から使うため独立モジュールに置く
// （settings.ts から view.ts を参照すると main.ts 経由で循環参照になるため）
// confirm dialog for destructive actions, shared by the view and the settings tab; it lives in its
// own module because importing it from view.ts would cycle back through main.ts into settings.ts
import { App, Modal, SuggestModal } from "obsidian";

export interface ConfirmOpts {
  title: string;
  body: string;
  sub?: string;
  confirmText: string;
  cancelText: string;
  onConfirm: () => void;
}
export class ConfirmModal extends Modal {
  constructor(app: App, private opts: ConfirmOpts) {
    super(app);
  }
  onOpen(): void {
    this.titleEl.setText(this.opts.title);
    this.contentEl.createEl("p", { text: this.opts.body });
    if (this.opts.sub) this.contentEl.createEl("p", { cls: "ogantt-confirm-sub", text: this.opts.sub });
    const btns = this.contentEl.createDiv({ cls: "ogantt-confirm-btns" });
    const cancel = btns.createEl("button", { text: this.opts.cancelText });
    cancel.onclick = () => this.close();
    const ok = btns.createEl("button", { cls: "mod-warning", text: this.opts.confirmText });
    ok.onclick = () => {
      this.close();
      this.opts.onConfirm();
    };
    window.setTimeout(() => ok.focus(), 0); // Enter で即確定 / Enter confirms
  }
  onClose(): void {
    this.contentEl.empty();
  }
}

// 候補一覧から1件選ばせる小さなピッカー（タグ名の手入力ミスを避けるために使う）
// a small picker over a fixed list of choices, used so tag names never have to be typed by hand
export class TagSuggestModal extends SuggestModal<string> {
  constructor(app: App, private choices: string[], placeholder: string, private onPick: (value: string) => void) {
    super(app);
    this.setPlaceholder(placeholder);
  }
  getSuggestions(query: string): string[] {
    const q = query.trim().toLowerCase();
    return q ? this.choices.filter((c) => c.toLowerCase().includes(q)) : this.choices;
  }
  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value);
  }
  onChooseSuggestion(value: string): void {
    this.onPick(value);
  }
}
