/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

declare const __BUILD_ID__: string;

interface ImportMetaEnv {
  readonly VITE_TURNSTILE_SITE_KEY?: string;
  readonly VITE_CAPABILITY_AUTH_ENABLED?: string;
  readonly VITE_CAPABILITY_ROUTES_ENABLED?: string;
  readonly VITE_ADMIN_PANEL_ENABLED?: string;
  readonly VITE_REALTIME_HUB_SYNC_ENABLED?: string;
  readonly VITE_REALTIME_HUB_ID?: string;
  readonly VITE_REALTIME_HUB_URL?: string;
  readonly VITE_REALTIME_TICKET_PUBLIC_KEYS_JSON?: string;
  readonly VITE_REALTIME_SAVED_ACK_PUBLIC_KEYS_JSON?: string;
}
