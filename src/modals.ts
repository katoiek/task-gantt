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

// ボタンで 1 つ選ばせるダイアログ。どれも選ばずに閉じたら（Esc・×・外側クリック）onDismiss
// a dialog that asks for one of several buttons; closing without choosing (Esc, ×, outside click) calls onDismiss
export interface ChoiceOpts {
  title: string;
  body: string;
  sub?: string;
  choices: { text: string; cta?: boolean; onPick: () => void }[];
  onDismiss: () => void;
}
export class ChoiceModal extends Modal {
  private picked = false;
  constructor(app: App, private opts: ChoiceOpts) {
    super(app);
  }
  onOpen(): void {
    this.titleEl.setText(this.opts.title);
    this.contentEl.createEl("p", { text: this.opts.body });
    if (this.opts.sub) this.contentEl.createEl("p", { cls: "ogantt-confirm-sub", text: this.opts.sub });
    const btns = this.contentEl.createDiv({ cls: "ogantt-confirm-btns" });
    for (const c of this.opts.choices) {
      const b = btns.createEl("button", { cls: c.cta ? "mod-cta" : "", text: c.text });
      b.onclick = () => {
        this.picked = true;
        this.close();
        c.onPick();
      };
      if (c.cta) window.setTimeout(() => b.focus(), 0); // Enter で主な選択肢 / Enter picks the main choice
    }
  }
  onClose(): void {
    this.contentEl.empty();
    if (!this.picked) this.opts.onDismiss();
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
