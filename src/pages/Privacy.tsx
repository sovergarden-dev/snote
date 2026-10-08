// Static privacy policy for the web app and Chrome side-panel extension.
import { CompanyFooter } from "@/components/CompanyFooter";

export default function Privacy() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-12 text-foreground">
      <h1 className="text-2xl font-semibold tracking-tight">Privacy Policy</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Last updated: October 8, 2026
      </p>

      <section className="mt-8 space-y-3">
        <h2 className="text-lg font-medium">Scope</h2>
        <p>
          Syrin Notes is operated by Syrin, based in Ho Chi Minh City, Vietnam.{" "}
          This policy covers the Syrin Notes web app at{" "}
          <a href="https://note.syrin.online" className="underline">
            note.syrin.online
          </a>{" "}
          and the “Syrin Note — Side Panel” Chrome extension. The extension
          loads that web app in Chrome's side panel and adds settings,
          reliability diagnostics, and a strict-origin messaging bridge.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-lg font-medium">Data the service handles</h2>
        <p>
          Syrin Notes does not require an account. The app handles note content,
          note locators, encryption metadata, and the settings needed to edit,
          sync, share, and recover notes. Unless you enable client-side
          encryption, note content is sent to the backend as plaintext. With
          encryption enabled, ciphertext and operational metadata are still
          sent so the service can store and synchronize the note.
        </p>
        <ul className="list-disc space-y-1 pl-6">
          <li>No advertising SDKs, tracking pixels, or third-party analytics.</li>
          <li>The extension does not read page content or browser history.</li>
          <li>The app uses browser language preferences and does not use IP geolocation.</li>
        </ul>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-lg font-medium">Extension permissions and local storage</h2>
        <p>The extension requests two Chrome permissions:</p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>sidePanel</strong> — opens Syrin Notes in Chrome's side
            panel.
          </li>
          <li>
            <strong>storage</strong> — stores the open mode, default or last
            note locator, and debug setting in <code>chrome.storage.sync</code>.
            If sync is unavailable, the panel uses safe defaults rather
            than copying those locators into device-local storage.
          </li>
        </ul>
        <p>
          Device-local <code>chrome.storage.local</code> keeps edit capabilities
          for notes opened through the extension, plus the diagnostics opt-in
          and optional reliability diagnostics. Owner capabilities are never
          stored by the extension or synced between devices. Diagnostics contain
          bounded event names and technical status fields, not note
           content or full URLs. They are never uploaded automatically, can be
           disabled, or cleared in Settings. Events older than 7 days are
           discarded the next time diagnostics are read or written. If the
           extension is not used, expired entries can remain on the device until
           that next use.
          Edit capabilities and diagnostics remain only on that Chrome profile
          until you clear extension data or uninstall the extension. Synced
          settings remain until you clear extension data or uninstall the
          extension, subject to Chrome sync behavior.
        </p>
        <p>
          The extension does not request <code>tabs</code>,{" "}
          <code>activeTab</code>, <code>scripting</code>, or host permissions.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-lg font-medium">Network processing and logs</h2>
        <p>
          Hosting, CDN, and backend providers process standard connection metadata
          such as an IP address, user agent, request time, and response status to
          deliver and protect the service. Operational logs are limited to what
          is needed for reliability, abuse prevention, and security; the app is
          designed not to place note content, raw note locators, share tokens, or
          raw IP addresses in application logs.
        </p>
        <p>
          Admin abuse protection stores keyed admin abuse-prevention hashes derived
          from a gateway-verified network address, not the raw address, in the app
          database. Failed-attempt hashes become eligible for deletion after seven
          days; a daily retention job removes them, and each admin authentication
          request also runs the same cleanup. Expired opaque admin-session hashes
          are removed by that cleanup as well.
        </p>
        <p>
          Provider-level logs, backups, and service data follow the applicable
          provider retention settings and legal obligations. Notes remain in the
          backend until deleted or removed under the service's maintenance and
          recovery processes. A revoked share link should no longer grant access.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-lg font-medium">Chrome Web Store Limited Use</h2>
        <p>
          Information received from Chrome APIs is used only to provide or
          improve the extension's single purpose. It is not sold, used for
          personalized advertising or credit decisions, or made available for
          human review except when you explicitly request support or when needed
          for security, legal compliance, or an allowed business transfer. This
          use complies with the Chrome Web Store User Data Policy, including its
          Limited Use requirements.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-lg font-medium">Your controls</h2>
        <p>
          You can disable or clear local diagnostics in extension Settings,
          clear browser or extension storage, delete a note where the product
          exposes that control, revoke share links, or uninstall the extension.
          Keep encryption keys and private note links secure; losing an
          encryption key may make encrypted content unrecoverable.
        </p>
      </section>

      <section className="mt-8 space-y-3">
        <h2 className="text-lg font-medium">Changes and contact</h2>
        <p>
          Material changes will update the date above and be published here.
          {" "}Questions or privacy requests:{" "}
          <a href="mailto:syringa@syrin.online" className="underline">
            syringa@syrin.online
          </a>
        </p>
      </section>
      <CompanyFooter />
    </main>
  );
}
