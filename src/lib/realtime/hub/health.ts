import { verifyProtocolJws, type JwsPinnedKeySets } from "../protocol";
import type { HubClock } from "./clock";
import { nowSeconds, systemHubClock } from "./clock";

export async function verifyHubProbe(
  token: string,
  hubId: string,
  pinnedKeys: JwsPinnedKeySets,
  clock: HubClock = systemHubClock,
): Promise<boolean> {
  try {
    const now = nowSeconds(clock);
    const claims = await verifyProtocolJws(token, {
      tokenType: "probe",
      pinnedKeys,
      expectedAudience: hubId,
      nowSeconds: now,
    });
    return Number.isSafeInteger(claims.iat)
      && Number.isSafeInteger(claims.exp)
      && (claims.exp as number) > now
      && (claims.exp as number) - (claims.iat as number) <= 30;
  } catch {
    return false;
  }
}
