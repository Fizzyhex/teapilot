import { describe, expect, it, vi } from 'vitest';
import { collectPadInputs, decodeDualSense, DualSenseHid } from '../web/gamepad.js';
import type { HidApi, HidDevice } from '../web/gamepad.js';

function report(layout: 'usb' | 'compact' | 'bluetooth', face = 8, shoulder = 0, extra = 0) {
  const bytes = new Uint8Array(layout === 'usb' ? 63 : layout === 'compact' ? 9 : 77);
  const offset = layout === 'bluetooth' ? 1 : 0;
  bytes.fill(128, offset, offset + 4);
  const buttons = layout === 'compact' ? 4 : offset + 7;
  bytes.set([face, shoulder, extra], buttons);
  return { reportId: layout === 'bluetooth' ? 0x31 : 0x01, data: new DataView(bytes.buffer) };
}
function inputs(state: ReturnType<typeof decodeDualSense>, previous = new Set<string>()) {
  const now = new Set<string>();
  if (state) collectPadInputs(state, now, previous);
  return [...now];
}

describe('dualsense reports', () => {
  for (const layout of ['usb', 'compact', 'bluetooth'] as const) {
    it(`decodes ${layout} neutral, standard buttons and all stick directions`, () => {
      const neutral = report(layout);
      expect(inputs(decodeDualSense(neutral.reportId, neutral.data))).toEqual([]);
      const cases = [
        [0x28, 0, 0, 0], [0x48, 0, 0, 1], [0x18, 0, 0, 2], [0x88, 0, 0, 3],
        ...Array.from({ length: 8 }, (_, i) => [8, 1 << i, 0, i + 4]),
        [8, 0, 1, 16], [8, 0, 2, 17],
        ...(layout === 'compact' ? [] : [[8, 0, 4, 18]]),
      ];
      for (const [face, shoulder, extra, button] of cases) {
        const packet = report(layout, face, shoulder, extra);
        expect(inputs(decodeDualSense(packet.reportId, packet.data))).toEqual([`button ${button}`]);
      }
      const axes = report(layout);
      const start = layout === 'bluetooth' ? 1 : 0;
      for (let i = 0; i < 4; i++) {
        for (const value of [0, 255]) {
          axes.data.setUint8(start + i, value);
          expect(inputs(decodeDualSense(axes.reportId, axes.data))).toEqual([`axis ${i} ${value ? '+' : '-'}`]);
          axes.data.setUint8(start + i, 128);
        }
      }
    });
    it(`decodes ${layout} d-pad diagonals`, () => {
      const expected = [[12], [12, 15], [15], [13, 15], [13], [13, 14], [14], [12, 14], []];
      expected.forEach((buttons, hat) => {
        const packet = report(layout, hat);
        expect(inputs(decodeDualSense(packet.reportId, packet.data))).toEqual(buttons.map(i => `button ${i}`));
      });
    });
  }
  it('rejects unknown and truncated reports, and honors DataView byte offsets', () => {
    for (const id of [0, 1, 0x31, 0xff]) {
      for (const size of [0, 1, 8, 10, 62, 64, 76]) expect(decodeDualSense(id, new DataView(new ArrayBuffer(size)))).toBeUndefined();
    }
    const packet = report('usb', 0x28);
    const buffer = new Uint8Array(80);
    buffer.set(new Uint8Array(packet.data.buffer), 5);
    expect(inputs(decodeDualSense(1, new DataView(buffer.buffer, 5, 63)))).toEqual(['button 0']);
  });
  it('shares axis hysteresis and deduplicates Gamepad / HID inputs', () => {
    const now = new Set<string>();
    const pad = { buttons: [true], axes: [0.5] };
    collectPadInputs(pad, now, new Set());
    expect([...now]).toEqual(['button 0']);
    collectPadInputs(pad, now, new Set(['axis 0 +']));
    collectPadInputs(pad, now, new Set(['axis 0 +']));
    expect([...now]).toEqual(['button 0', 'axis 0 +']);
    expect(inputs({ buttons: [], axes: [0.3] }, new Set(['axis 0 +']))).toEqual([]);
  });
});

class Device extends EventTarget implements HidDevice {
  vendorId = 0x054c;
  productId = 0x0ce6;
  opened = false;
  open = vi.fn(async () => { this.opened = true; });
  close = vi.fn(async () => { this.opened = false; });
  send(layout: 'usb' | 'compact' | 'bluetooth' = 'usb', face = 0x28) {
    this.dispatchEvent(Object.assign(new Event('inputreport'), report(layout, face)));
  }
}
class Hid extends EventTarget implements HidApi {
  getDevices = vi.fn(async () => [] as HidDevice[]);
  requestDevice = vi.fn(async (_options: { filters: { vendorId: number; productId: number }[] }) => [] as HidDevice[]);
  event(type: string, device: Device) { this.dispatchEvent(Object.assign(new Event(type), { device })); }
}
function setup() {
  const hid = new Hid(), status = vi.fn();
  const controller = new DualSenseHid(hid, status);
  const collect = () => { const now = new Set<string>(); controller.collect(now, new Set()); return [...now]; };
  return { hid, status, controller, collect };
}

describe('WebHID connection lifecycle', () => {
  it('requests permission synchronously, opens a filtered device, and releases held inputs', async () => {
    const { hid, status, controller, collect } = setup();
    const device = new Device();
    hid.requestDevice.mockResolvedValue([device]);
    const request = controller.request();
    expect(hid.requestDevice).toHaveBeenCalledWith({ filters: [{ vendorId: 0x054c, productId: 0x0ce6 }] });
    await request;
    expect(device.open).toHaveBeenCalledOnce();
    device.send();
    expect(collect()).toEqual(['button 0']);
    device.send('usb', 8);
    expect(collect()).toEqual([]);
    device.send();
    hid.event('disconnect', device);
    expect(collect()).toEqual([]);
    expect(status).toHaveBeenLastCalledWith('controller disconnected.');
    controller.stop();
  });
  it('restores only supported authorized devices and cleans up listeners / owned connections', async () => {
    const { hid, status, controller, collect } = setup();
    const device = new Device(), unsupported = new Device(), alreadyOpen = new Device();
    unsupported.productId = 0x1234;
    alreadyOpen.opened = true;
    hid.getDevices.mockResolvedValue([device, unsupported, alreadyOpen]);
    await controller.restore();
    expect(unsupported.open).not.toHaveBeenCalled();
    expect(alreadyOpen.open).not.toHaveBeenCalled();
    hid.event('connect', device);
    expect(device.open).toHaveBeenCalledOnce();
    device.send('bluetooth');
    expect(collect()).toEqual(['button 0']);
    controller.stop();
    expect(device.close).toHaveBeenCalledOnce();
    expect(alreadyOpen.close).not.toHaveBeenCalled();
    status.mockClear();
    device.send();
    hid.event('connect', new Device());
    expect(status).not.toHaveBeenCalled();
    expect(collect()).toEqual([]);
  });
  it('handles chooser cancellation, permission denial and open failure without losing retry', async () => {
    const { hid, status, controller } = setup();
    await controller.request();
    expect(status).toHaveBeenLastCalledWith('no controller selected.');
    hid.requestDevice.mockRejectedValueOnce(new Error('denied'));
    await expect(controller.request()).resolves.toBeUndefined();
    expect(status.mock.lastCall?.[0]).toContain('could not connect');
    const device = new Device();
    device.open.mockRejectedValueOnce(new Error('busy'));
    hid.requestDevice.mockResolvedValue([device]);
    await controller.request();
    expect(status.mock.lastCall?.[0]).toContain('could not connect');
    await controller.request();
    expect(device.opened).toBe(true);
    controller.stop();
  });
  it('closes an open that completes after teardown', async () => {
    const { hid, controller, status } = setup();
    const device = new Device();
    let finish!: () => void;
    device.open.mockImplementation(() => new Promise<void>(resolve => { finish = () => { device.opened = true; resolve(); }; }));
    hid.getDevices.mockResolvedValue([device]);
    const restoring = controller.restore();
    await Promise.resolve();
    controller.stop();
    finish();
    await restoring;
    expect(device.close).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });
  it('reopens an authorized controller after disconnect / reconnect', async () => {
    const { hid, controller, collect } = setup();
    const device = new Device();
    hid.requestDevice.mockResolvedValue([device]);
    await controller.request();
    hid.event('disconnect', device);
    device.opened = false;
    hid.event('connect', device);
    await Promise.resolve();
    device.send('compact');
    expect(collect()).toEqual(['button 0']);
    expect(device.open).toHaveBeenCalledTimes(2);
    controller.stop();
  });
});
