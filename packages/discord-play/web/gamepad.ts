export type PadState = { buttons: readonly boolean[]; axes: readonly number[] };

export function collectPadInputs(pad: PadState, now: Set<string>, previous: ReadonlySet<string>) {
  pad.buttons.forEach((pressed, i) => { if (pressed) now.add(`button ${i}`); });
  pad.axes.forEach((axis, i) => {
    for (const direction of [-1, 1]) {
      const name = `axis ${i} ${direction < 0 ? '-' : '+'}`;
      if (axis * direction > (previous.has(name) ? 0.35 : 0.65)) now.add(name);
    }
  });
}

// WebHID excludes the report id from data. DualSense has USB, compact BT and extended BT layouts.
export function decodeDualSense(reportId: number, data: DataView): PadState | undefined {
  const compact = reportId === 0x01 && data.byteLength === 9;
  const offset = reportId === 0x31 && data.byteLength === 77 ? 1 : 0;
  if (!compact && !(reportId === 0x01 && data.byteLength === 63) && !offset) return;
  const face = data.getUint8(compact ? 4 : offset + 7);
  const shoulder = data.getUint8(compact ? 5 : offset + 8);
  const extra = data.getUint8(compact ? 6 : offset + 9);
  const hat = face & 15;
  const bit = (value: number, mask: number) => Boolean(value & mask);
  // Match the Gamepad API's standard button numbering so bindings work with either source.
  return {
    buttons: [
      bit(face, 0x20), bit(face, 0x40), bit(face, 0x10), bit(face, 0x80),
      bit(shoulder, 1), bit(shoulder, 2), bit(shoulder, 4), bit(shoulder, 8),
      bit(shoulder, 0x10), bit(shoulder, 0x20), bit(shoulder, 0x40), bit(shoulder, 0x80),
      [0, 1, 7].includes(hat), [3, 4, 5].includes(hat), [5, 6, 7].includes(hat), [1, 2, 3].includes(hat),
      bit(extra, 1), bit(extra, 2), !compact && bit(extra, 4),
    ],
    axes: Array.from({ length: 4 }, (_, i) => data.getUint8(offset + i) / 127.5 - 1),
  };
}

export interface HidDevice extends EventTarget {
  vendorId: number;
  productId: number;
  opened: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
}
export interface HidApi extends EventTarget {
  getDevices(): Promise<HidDevice[]>;
  requestDevice(options: { filters: { vendorId: number; productId: number }[] }): Promise<HidDevice[]>;
}
type ReportEvent = Event & { reportId: number; data: DataView };
type DeviceEvent = Event & { device: HidDevice };
const filter = { vendorId: 0x054c, productId: 0x0ce6 };
const supported = (device: HidDevice) => device.vendorId === filter.vendorId && device.productId === filter.productId;

export class DualSenseHid {
  private stopped = false;
  private devices = new Map<HidDevice, { state?: PadState; listener: EventListener; owned: boolean }>();
  private hid: HidApi;
  private status: (text: string) => void;
  constructor(hid: HidApi, status: (text: string) => void) {
    this.hid = hid;
    this.status = status;
    hid.addEventListener('connect', this.connect);
    hid.addEventListener('disconnect', this.disconnect);
  }
  private connect = (event: Event) => { void this.open((event as DeviceEvent).device).catch(() => this.notify('could not open controller. close other controller apps and try again.')); };
  private disconnect = (event: Event) => {
    const device = (event as DeviceEvent).device;
    const entry = this.devices.get(device);
    if (!entry) return;
    device.removeEventListener('inputreport', entry.listener);
    this.devices.delete(device);
    this.notify('controller disconnected.');
  };
  private notify(text: string) { if (!this.stopped) this.status(text); }
  private async open(device: HidDevice) {
    if (this.stopped || !supported(device) || this.devices.has(device)) return;
    const entry = { state: undefined as PadState | undefined, owned: !device.opened, listener: ((event: Event) => {
      const report = event as ReportEvent;
      const state = decodeDualSense(report.reportId, report.data);
      if (state) { entry.state = state; this.notify('dualsense connected.'); }
    }) as EventListener };
    this.devices.set(device, entry);
    try {
      if (entry.owned) await device.open();
      if (this.stopped || this.devices.get(device) !== entry) {
        if (entry.owned && device.opened) await device.close();
        return;
      }
      device.addEventListener('inputreport', entry.listener);
      this.notify('dualsense opened · press a controller button.');
    } catch (error) { this.devices.delete(device); throw error; }
  }
  async restore() {
    try { for (const device of await this.hid.getDevices()) await this.open(device); }
    catch { this.notify('could not restore controller. open controls and click “controller not working? click here” to try again.'); }
  }
  async request() {
    try {
      // Keep the chooser in the click's user-activation context; do not await anything first.
      const devices = await this.hid.requestDevice({ filters: [filter] });
      if (!devices.length) { this.notify('no controller selected.'); return; }
      for (const device of devices) await this.open(device);
    } catch { this.notify('could not connect controller. check browser permission and close other controller apps.'); }
  }
  collect(now: Set<string>, previous: ReadonlySet<string>) {
    for (const entry of this.devices.values()) if (entry.state) collectPadInputs(entry.state, now, previous);
  }
  stop() {
    this.stopped = true;
    this.hid.removeEventListener('connect', this.connect);
    this.hid.removeEventListener('disconnect', this.disconnect);
    for (const [device, entry] of this.devices) {
      device.removeEventListener('inputreport', entry.listener);
      if (entry.owned && device.opened) void device.close().catch(() => {});
    }
    this.devices.clear();
  }
}
