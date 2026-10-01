import type { Api, Model } from "@earendil-works/pi-ai";
import {
  getSelectListTheme,
  type ExtensionCommandContext,
  type ScopedModel,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  getKeybindings,
  Input,
  SelectList,
  Spacer,
  stripTerminalSequences,
  truncateToWidth,
  Text,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { modelIdentity } from "./models.ts";
import { dialogHeight, frameDialog, DIALOG_OPTIONS } from "./dialog.ts";

const MODEL_EDITOR_LAYOUT = {
  minPrimaryColumnWidth: 24,
  maxPrimaryColumnWidth: 52,
} as const;

const PICKER_TITLE = "Preferred models";

export const MODEL_EDITOR_CANCEL = Symbol("model-editor-cancel");

type AvailableModel = Pick<Model<Api>, "provider" | "id" | "name">;

type ModelEditorMode =
  | { kind: "menu" }
  | { kind: "actions"; index: number }
  | {
      kind: "picker";
      replaceIndex: number | undefined;
      returnTo: "menu" | "actions";
    };

interface OrderedModelEditorComponentOptions {
  tui: { requestRender(force?: boolean): void; terminal?: { rows: number } };
  theme: Theme;
  availableModels: readonly AvailableModel[];
  scopedModels: readonly ScopedModel[];
  initialModels?: readonly string[];
  onDone(models: string[]): void;
  onCancel(): void;
}

function sanitizeModelText(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

function renderModelIdentity(identity: string): string {
  return sanitizeModelText(identity);
}

function sortModels(models: readonly AvailableModel[]): AvailableModel[] {
  const unique = new Map<string, AvailableModel>();
  for (const model of models) unique.set(modelIdentity(model), model);
  return [...unique.values()].sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) ||
      a.id.localeCompare(b.id) ||
      sanitizeModelText(a.name).localeCompare(sanitizeModelText(b.name)),
  );
}

function describeModel(
  model: AvailableModel,
  scopedIdentities: ReadonlySet<string>,
): string {
  const annotation = scopedIdentities.has(modelIdentity(model))
    ? "scoped in this session"
    : "portable preference · not scoped in this session";
  const name = sanitizeModelText(model.name);
  return [name, annotation].filter(Boolean).join(" · ");
}

function buildSearchText(
  model: AvailableModel,
  scopedIdentities: ReadonlySet<string>,
): string {
  return [
    renderModelIdentity(modelIdentity(model)),
    sanitizeModelText(model.name),
    describeModel(model, scopedIdentities),
  ]
    .filter(Boolean)
    .join(" ");
}

export class OrderedModelEditorComponent extends Container {
  private readonly tui: {
    requestRender(force?: boolean): void;
    terminal?: { rows: number };
  };
  private readonly theme: Theme;
  private readonly allModels: readonly AvailableModel[];
  private readonly modelsByIdentity = new Map<string, AvailableModel>();
  private readonly scopedIdentities: ReadonlySet<string>;
  private readonly onDone: (models: string[]) => void;
  private readonly onCancel: () => void;
  private readonly body = new Container();
  private readonly titleText = new Text();
  private readonly subtitleText = new Text();
  private readonly footerText = new Text();
  private draft: string[];
  private mode: ModelEditorMode;
  private pickerQuery = "";
  private pickerSelectedValue: string | undefined;
  private currentItems: SelectItem[] = [];
  private selectList = new SelectList(
    [],
    1,
    getSelectListTheme(),
    MODEL_EDITOR_LAYOUT,
  );
  private searchInput: Input | undefined;
  private pickerListChildIndex = -1;
  private menuSelectedValue: string | undefined;
  private actionSelectedValue: string | undefined;
  private _focused = false;

  constructor(options: OrderedModelEditorComponentOptions) {
    super();
    this.tui = options.tui;
    this.theme = options.theme;
    this.allModels = sortModels(options.availableModels);
    this.onDone = options.onDone;
    this.onCancel = options.onCancel;
    for (const model of this.allModels)
      this.modelsByIdentity.set(modelIdentity(model), model);
    this.scopedIdentities = new Set(
      options.scopedModels.map((entry) => modelIdentity(entry.model)),
    );
    this.draft = [...(options.initialModels ?? [])];
    this.mode =
      this.draft.length === 0
        ? { kind: "picker", replaceIndex: undefined, returnTo: "menu" }
        : { kind: "menu" };

    this.rebuild();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (this.searchInput) this.searchInput.focused = value;
  }

  getMode(): ModelEditorMode["kind"] {
    return this.mode.kind;
  }

  getDraftModels(): readonly string[] {
    return this.draft;
  }

  getCurrentItems(): readonly SelectItem[] {
    return this.currentItems;
  }

  getSelectList(): SelectList {
    return this.selectList;
  }

  getSearchInput(): Input | undefined {
    return this.searchInput;
  }

  render(width: number): string[] {
    const height = dialogHeight(this.tui);
    const inner = Math.max(1, width - 4);
    const header = [
      truncateToWidth(
        this.subtitleText
          .render(1000)
          .map((line) => line.trim())
          .filter(Boolean)
          .join(" "),
        inner,
        "",
      ),
    ];
    if (this.searchInput) header.push(...this.searchInput.render(inner));
    const budget = Math.max(1, height - 4 - header.length);
    const selected = this.selectList.getSelectedItem()?.value;
    const index = Math.max(
      0,
      this.currentItems.findIndex((item) => item.value === selected),
    );
    const start = Math.max(
      0,
      Math.min(index - budget + 1, this.currentItems.length - budget),
    );
    const rows = this.currentItems.slice(start, start + budget).map((item) => {
      const text = `${item.value === selected ? "›" : " "} ${item.label}  ${this.theme.fg("muted", item.description ?? "")}`;
      return item.value === selected ? this.theme.fg("accent", text) : text;
    });
    if (!rows.length) rows.push(this.theme.fg("muted", "No matching models"));
    return frameDialog(
      this.theme,
      width,
      height,
      this.titleText.render(1000).join(" ").trim(),
      [...header, ...rows].map((line) => ` ${line}`),
      this.footerText
        .render(1000)
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" "),
    );
  }

  handleInput(keyData: string): void {
    if (this.mode.kind === "picker" && this.searchInput) {
      const kb = getKeybindings();
      const isNav =
        kb.matches(keyData, "tui.select.up") ||
        kb.matches(keyData, "tui.select.down") ||
        kb.matches(keyData, "tui.select.confirm") ||
        kb.matches(keyData, "tui.select.cancel");
      if (isNav) {
        this.selectList.handleInput(keyData);
      } else {
        this.searchInput.handleInput(keyData);
        const nextQuery = this.searchInput.getValue();
        if (nextQuery !== this.pickerQuery) {
          this.pickerQuery = nextQuery;
          this.pickerSelectedValue = undefined;
          this.refreshPickerList(this.mode.replaceIndex, this.mode.returnTo);
          this.tui.requestRender();
          return;
        }
      }
      this.tui.requestRender();
      return;
    }
    this.selectList.handleInput(keyData);
    this.tui.requestRender();
  }

  private rebuild(): void {
    this.body.clear();
    this.searchInput = undefined;
    this.pickerListChildIndex = -1;
    if (this.mode.kind === "menu") {
      this.buildMenu();
    } else if (this.mode.kind === "actions") {
      this.buildActions(this.mode.index);
    } else {
      this.buildPicker(this.mode.replaceIndex);
    }
  }

  private buildMenu(): void {
    this.titleText.setText(this.theme.fg("accent", PICKER_TITLE));
    this.subtitleText.setText(
      this.theme.fg(
        "muted",
        this.withScopeWarning(
          this.draft.length
            ? "Ordered fallback preferences. Select a numbered entry for actions."
            : "No explicit preferences. Add models or done to inherit the default.",
        ),
      ),
    );
    const items: SelectItem[] = [
      ...this.draft.map((identity, index) => ({
        value: `entry:${index}`,
        label: `${index + 1}. ${renderModelIdentity(identity)}`,
        description: this.describeDraftIdentity(identity),
      })),
      {
        value: "action:add",
        label: "Add model",
        description: "Append another preferred model to the ordered list",
      },
      {
        value: "action:clear",
        label: "Use inherited default",
        description: "Clear explicit preferences and inherit the default model",
      },
      {
        value: "action:done",
        label: "Done",
        description: "Commit this ordered model preference list",
      },
      {
        value: "action:cancel",
        label: "Cancel",
        description: "Discard unsaved model preference changes",
      },
    ];
    this.currentItems = items;
    this.selectList = this.buildSelectList(
      items,
      this.menuSelectedValue,
      (value) => {
        if (value.startsWith("entry:")) {
          const index = Number(value.slice("entry:".length));
          if (!Number.isNaN(index) && this.draft[index] !== undefined) {
            this.mode = { kind: "actions", index };
            this.actionSelectedValue = "action:replace";
            this.rebuildAndRender();
          }
          return;
        }
        if (value === "action:add") {
          this.openPicker(undefined, "menu");
        } else if (value === "action:clear") {
          this.draft = [];
          this.menuSelectedValue = "action:done";
          this.rebuildAndRender();
        } else if (value === "action:done") {
          this.onDone([...this.draft]);
        } else if (value === "action:cancel") {
          this.onCancel();
        }
      },
      () => this.onCancel(),
    );
    this.body.addChild(this.selectList);
    this.footerText.setText(
      this.theme.fg(
        "dim",
        "↑↓ select · Enter edit · Esc cancel · Done applies preferences",
      ),
    );
  }

  private buildActions(index: number): void {
    const identity = this.draft[index] ?? "";
    this.titleText.setText(this.theme.fg("accent", `Model ${index + 1}`));
    this.subtitleText.setText(
      this.theme.fg(
        "muted",
        `${index + 1}. ${renderModelIdentity(identity)} · ${this.describeDraftIdentity(identity)}`,
      ),
    );
    const items: SelectItem[] = [
      {
        value: "action:replace",
        label: "Replace",
        description: "Choose a different available model for this position",
      },
      {
        value: "action:remove",
        label: "Remove",
        description: "Delete this preference from the ordered list",
      },
      ...(index > 0
        ? [
            {
              value: "action:earlier",
              label: "Move earlier",
              description: "Swap with the previous preference",
            },
          ]
        : []),
      ...(index < this.draft.length - 1
        ? [
            {
              value: "action:later",
              label: "Move later",
              description: "Swap with the next preference",
            },
          ]
        : []),
      {
        value: "action:back",
        label: "Back",
        description: "Return to the ordered preference list",
      },
    ];
    this.currentItems = items;
    this.selectList = this.buildSelectList(
      items,
      this.actionSelectedValue,
      (value) => {
        if (value === "action:replace") {
          this.openPicker(index, "actions");
        } else if (value === "action:remove") {
          this.draft.splice(index, 1);
          this.mode = { kind: "menu" };
          this.menuSelectedValue = this.draft[index]
            ? `entry:${index}`
            : "action:add";
          this.rebuildAndRender();
        } else if (value === "action:earlier" && index > 0) {
          [this.draft[index - 1], this.draft[index]] = [
            this.draft[index],
            this.draft[index - 1],
          ];
          this.mode = { kind: "menu" };
          this.menuSelectedValue = `entry:${index - 1}`;
          this.rebuildAndRender();
        } else if (value === "action:later" && index < this.draft.length - 1) {
          [this.draft[index], this.draft[index + 1]] = [
            this.draft[index + 1],
            this.draft[index],
          ];
          this.mode = { kind: "menu" };
          this.menuSelectedValue = `entry:${index + 1}`;
          this.rebuildAndRender();
        } else if (value === "action:back") {
          this.mode = { kind: "menu" };
          this.menuSelectedValue = `entry:${index}`;
          this.rebuildAndRender();
        }
      },
      () => {
        this.mode = { kind: "menu" };
        this.menuSelectedValue = `entry:${index}`;
        this.rebuildAndRender();
      },
    );
    this.body.addChild(this.selectList);
    this.footerText.setText(
      this.theme.fg("dim", "↑↓ select · Enter choose · Esc back"),
    );
  }

  private buildPicker(replaceIndex: number | undefined): void {
    const isReplace = replaceIndex !== undefined;
    this.titleText.setText(
      this.theme.fg(
        "accent",
        isReplace ? `Replace model ${replaceIndex + 1}` : "Add model",
      ),
    );
    this.subtitleText.setText(
      this.theme.fg(
        "muted",
        this.withScopeWarning(
          "Search by provider/id or model name. Already-selected duplicates are hidden.",
        ),
      ),
    );
    this.searchInput = new Input({ placeholder: "Search models" });
    this.searchInput.setValue(this.pickerQuery);
    this.searchInput.focused = this._focused;
    this.searchInput.onSubmit = () => {
      this.selectList.handleInput("\r");
      this.tui.requestRender();
    };
    this.body.addChild(this.searchInput);
    this.body.addChild(new Spacer(1));
    const returnTo = this.mode.kind === "picker" ? this.mode.returnTo : "menu";
    this.pickerListChildIndex = this.body.children.length;
    this.refreshPickerList(replaceIndex, returnTo);
    this.footerText.setText(
      this.theme.fg("dim", "Type filter · ↑↓ select · Enter choose · Esc back"),
    );
  }

  private rebuildAndRender(): void {
    this.rebuild();
    this.tui.requestRender();
  }

  private openPicker(
    replaceIndex: number | undefined,
    returnTo: "menu" | "actions",
  ): void {
    this.mode = { kind: "picker", replaceIndex, returnTo };
    this.pickerQuery = "";
    this.pickerSelectedValue = undefined;
    this.rebuildAndRender();
  }

  private refreshPickerList(
    replaceIndex: number | undefined,
    returnTo: "menu" | "actions",
  ): void {
    const items = this.getPickerItems(replaceIndex);
    this.currentItems = items;
    const list = this.buildSelectList(
      items,
      this.pickerSelectedValue,
      (value) => {
        if (replaceIndex === undefined) this.draft.push(value);
        else this.draft[replaceIndex] = value;
        this.mode = { kind: "menu" };
        this.menuSelectedValue = `entry:${replaceIndex === undefined ? this.draft.length - 1 : replaceIndex}`;
        this.pickerQuery = "";
        this.pickerSelectedValue = undefined;
        this.rebuildAndRender();
      },
      () => {
        this.mode =
          returnTo === "actions" && replaceIndex !== undefined
            ? { kind: "actions", index: replaceIndex }
            : { kind: "menu" };
        this.pickerQuery = "";
        this.pickerSelectedValue = undefined;
        this.rebuildAndRender();
      },
    );
    this.selectList = list;
    if (this.body.children[this.pickerListChildIndex])
      this.body.children[this.pickerListChildIndex] = list;
    else this.body.addChild(list);
  }

  private buildSelectList(
    items: SelectItem[],
    selectedValue: string | undefined,
    onSelect: (value: string) => void,
    onCancel: () => void,
  ): SelectList {
    const list = new SelectList(
      items,
      Math.min(Math.max(items.length, 1), 10),
      getSelectListTheme(),
      MODEL_EDITOR_LAYOUT,
    );
    const selectedIndex = selectedValue
      ? items.findIndex((item) => item.value === selectedValue)
      : 0;
    if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex);
    list.onSelect = (item) => {
      if (this.mode.kind === "menu") this.menuSelectedValue = item.value;
      else if (this.mode.kind === "actions")
        this.actionSelectedValue = item.value;
      else this.pickerSelectedValue = item.value;
      onSelect(item.value);
    };
    list.onSelectionChange = (item) => {
      if (this.mode.kind === "menu") this.menuSelectedValue = item.value;
      else if (this.mode.kind === "actions")
        this.actionSelectedValue = item.value;
      else this.pickerSelectedValue = item.value;
      this.tui.requestRender();
    };
    list.onCancel = onCancel;
    return list;
  }

  private getPickerItems(replaceIndex: number | undefined): SelectItem[] {
    const excluded = new Set(
      this.draft.filter((_, index) => index !== replaceIndex),
    );
    const available = this.allModels.filter(
      (model) => !excluded.has(modelIdentity(model)),
    );
    const filtered = this.pickerQuery
      ? fuzzyFilter(available, this.pickerQuery, (model) =>
          buildSearchText(model, this.scopedIdentities),
        )
      : available;
    return filtered.map((model) => ({
      value: modelIdentity(model),
      label: renderModelIdentity(modelIdentity(model)),
      description: describeModel(model, this.scopedIdentities),
    }));
  }

  private describeDraftIdentity(identity: string): string {
    const model = this.modelsByIdentity.get(identity);
    if (!model) return "unavailable in current model registry";
    return describeModel(model, this.scopedIdentities);
  }

  private withScopeWarning(text: string): string {
    if (this.scopedIdentities.size === 0) {
      return `No scoped models: explicit preferences cannot run. Configure /scoped-models. ${text}`;
    }
    return text;
  }
}

export async function editModelPreferences(
  ctx: ExtensionCommandContext,
  currentModels?: readonly string[],
): Promise<readonly string[] | typeof MODEL_EDITOR_CANCEL> {
  if (ctx.mode !== "tui") {
    if (ctx.hasUI) {
      ctx.ui.notify(
        "Ordered model preferences require interactive TUI mode; draft unchanged.",
        "warning",
      );
    }
    return MODEL_EDITOR_CANCEL;
  }
  const availableModels = ctx.modelRegistry.getAvailable().map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
  }));
  return ctx.ui.custom<readonly string[] | typeof MODEL_EDITOR_CANCEL>(
    (tui, theme, _keys, done) =>
      new OrderedModelEditorComponent({
        tui,
        theme,
        availableModels,
        scopedModels: ctx.scopedModels,
        initialModels: currentModels,
        onDone: (models) => done(models),
        onCancel: () => done(MODEL_EDITOR_CANCEL),
      }),
    DIALOG_OPTIONS,
  );
}
