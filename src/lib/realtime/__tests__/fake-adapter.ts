import {
  decodeRealtimeFrame,
  encodeRealtimeFrame,
  type RealtimeFrame,
} from "../protocol";

/** Test-only stand-in for runtime adapters; it performs no I/O or persistence. */
export class FakeProtocolAdapter {
  receive(frameBytes: Uint8Array): RealtimeFrame {
    return decodeRealtimeFrame(frameBytes);
  }

  send(frame: RealtimeFrame): Uint8Array {
    return encodeRealtimeFrame(frame);
  }
}
