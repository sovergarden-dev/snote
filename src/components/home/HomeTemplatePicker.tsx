import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n, type TKey } from "@/i18n";
import {
  BUILTIN_TEMPLATE_IDS,
  type BuiltinTemplateId,
  deleteCustomTemplate,
  getCustomTemplates,
  upsertCustomTemplate,
} from "@/lib/note-templates";

const BUILTIN_LABEL: Record<BuiltinTemplateId, TKey> = {
  blank: "home.templates.blank",
  meeting: "home.templates.meeting",
  daily: "home.templates.daily",
};

export function HomeTemplatePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const { t } = useI18n();
  const [custom, setCustom] = useState(() => getCustomTemplates());
  const [openForm, setOpenForm] = useState(false);
  const [name, setName] = useState("");
  const [markdown, setMarkdown] = useState("");
  const selectedCustom = custom.find((row) => row.id === value);

  return (
    <div className="flex min-h-8 min-w-0 sm:min-w-[22rem] flex-wrap items-center gap-2">
      <label htmlFor="home-template" className="text-[11px] text-muted-foreground">
        {t("home.templates.label")}
      </label>
      <select
        id="home-template"
        data-scene-btn="picker"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={t("home.templates.aria")}
        className="h-8 rounded-md border border-input bg-background px-2 text-xs"
      >
        {BUILTIN_TEMPLATE_IDS.map((id) => (
          <option key={id} value={id}>
            {t(BUILTIN_LABEL[id])}
          </option>
        ))}
        {custom.length > 0 && (
          <optgroup label={t("home.templates.custom")}>
            {custom.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      {selectedCustom && (
        <button
          type="button"
          className="text-[11px] text-muted-foreground hover:text-destructive"
          aria-label={t("home.templates.delete_aria", { name: selectedCustom.name })}
          onClick={() => {
            const next = deleteCustomTemplate(selectedCustom.id);
            setCustom(next);
            onChange("blank");
          }}
        >
          {t("home.templates.delete")}
        </button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 px-2 text-xs"
        onClick={() => setOpenForm((open) => !open)}
      >
        {t("home.templates.custom_save")}
      </Button>
      {openForm && (
        <form
          className="flex w-full flex-col gap-2 rounded-md border border-border p-2"
          onSubmit={(e) => {
            e.preventDefault();
            const saved = upsertCustomTemplate({ name, markdown });
            if (!saved) return;
            setCustom(getCustomTemplates());
            onChange(saved.id);
            setName("");
            setMarkdown("");
            setOpenForm(false);
          }}
        >
          <label htmlFor="home-template-name" className="sr-only">
            {t("home.templates.custom_name")}
          </label>
          <Input
            id="home-template-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("home.templates.custom_name")}
            className="h-8 text-xs"
          />
          <label htmlFor="home-template-body" className="sr-only">
            {t("home.templates.custom_body")}
          </label>
          <textarea
            id="home-template-body"
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            placeholder={t("home.templates.custom_body")}
            rows={4}
            className="rounded-md border border-input bg-transparent px-2 py-1 font-mono text-xs"
          />
          <Button type="submit" size="sm" disabled={!name.trim() || !markdown.trim()}>
            {t("home.templates.custom_create")}
          </Button>
        </form>
      )}
    </div>
  );
}

export default HomeTemplatePicker;
