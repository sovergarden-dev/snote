import { useI18n } from "@/i18n";

export function CompanyFooter() {
  const { t } = useI18n();

  return (
    <footer
      aria-label={t("footer.aria")}
      data-scene-type="ui"
      className="mt-14 border-t border-border/50 pt-5 pb-16 text-xs leading-5 text-muted-foreground"
    >
      <p>{t("footer.made_by")}</p>
      <nav
        aria-label={t("footer.links")}
        className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1"
      >
        <a
          href="/privacy"
          title={t("footer.privacy_title")}
          className="underline underline-offset-2"
        >
          {t("footer.privacy")}
        </a>
        <span aria-hidden="true">·</span>
        <a
          href="mailto:syringa@syrin.online"
          title={t("footer.email_title")}
          className="underline underline-offset-2"
        >
          {t("footer.email")}
        </a>
        <span aria-hidden="true">·</span>
        <span>{t("footer.copyright")}</span>
      </nav>
    </footer>
  );
}
