import { describe, expect, it } from 'vitest';
import { parseMqttFrameHeader, validateMqttPacket } from '../src/core/meetRelay';
import { MEET_MAX_PACKET_CHARS } from '../src/core/meetLink';

describe('MQTT frame bounds', () => {
  it('accepts bounded frames split across reads', () => {
    expect(parseMqttFrameHeader(Uint8Array.of(0x30))).toBeNull();
    expect(parseMqttFrameHeader(Uint8Array.of(0x30, 0x80))).toBeNull();
    expect(parseMqttFrameHeader(Uint8Array.of(0x30, 0x05, 0, 0, 0, 0, 0))).toEqual({ headerLen: 2, total: 7 });
  });

  it('rejects unterminated and oversized length fields', () => {
    expect(parseMqttFrameHeader(Uint8Array.of(0x30, 0x80, 0x80, 0x80, 0x80, 0x00)))
      .toEqual({ error: 'mqtt-length' });
    expect(parseMqttFrameHeader(Uint8Array.of(0x30, 0xff, 0xff, 0xff, 0x7f)))
      .toEqual({ error: 'mqtt-frame-too-large' });
    expect(parseMqttFrameHeader(Uint8Array.of(0x30, 0x81, 0x80, 0x08)))
      .toEqual({ error: 'mqtt-frame-too-large' });
  });

  it('accepts a frame exactly at the shared transport limit', () => {
    let n = MEET_MAX_PACKET_CHARS - 4;
    const length = [];
    do {
      let byte = n % 128;
      n = Math.floor(n / 128);
      if (n) byte |= 0x80;
      length.push(byte);
    } while (n);
    expect(parseMqttFrameHeader(Uint8Array.of(0x30, ...length)))
      .toEqual({ headerLen: length.length + 1, total: MEET_MAX_PACKET_CHARS });
  });
});

describe('MQTT packet validation', () => {
  it('accepts CONNACK, PUBLISH, SUBACK, and exact control packets', () => {
    expect(validateMqttPacket(Uint8Array.of(0x20, 0x02, 0x00, 0x00), 2)).toBeNull();
    expect(validateMqttPacket(Uint8Array.of(0x30, 0x04, 0x00, 0x01, 0x61, 0x62), 2)).toBeNull();
    expect(validateMqttPacket(Uint8Array.of(0x40, 0x02, 0x00, 0x01), 2)).toBeNull();
    expect(validateMqttPacket(Uint8Array.of(0x62, 0x02, 0x00, 0x01), 2)).toBeNull();
    expect(validateMqttPacket(Uint8Array.of(0xb0, 0x02, 0x00, 0x01), 2)).toBeNull();
    expect(validateMqttPacket(Uint8Array.of(0xd0, 0x00), 2)).toBeNull();
  });

  it('accepts a real 3-byte SUBACK with one grant byte', () => {
    // broker.emqx.io and HiveMQ both return packet id + granted QoS.
    expect(validateMqttPacket(Uint8Array.of(0x90, 0x03, 0x00, 0x01, 0x00), 2)).toBeNull();
    expect(validateMqttPacket(Uint8Array.of(0x90, 0x02, 0x00, 0x01), 2)).toBe('mqtt-control');
    expect(validateMqttPacket(Uint8Array.of(0x91, 0x03, 0x00, 0x01, 0x00), 2)).toBe('mqtt-control');
    expect(validateMqttPacket(Uint8Array.of(0x90, 0x03, 0x00, 0x00, 0x00), 2)).toBe('mqtt-control');
  });

  it('rejects invalid flags, lengths, topics, packet ids, and QoS', () => {
    expect(validateMqttPacket(Uint8Array.of(0x21, 0x02, 0x00, 0x00), 2)).toBe('mqtt-connack');
    expect(validateMqttPacket(Uint8Array.of(0x20, 0x03, 0x00, 0x00, 0x00), 2)).toBe('mqtt-connack');
    expect(validateMqttPacket(Uint8Array.of(0x36, 0x03, 0x00, 0x01, 0x61), 2)).toBe('mqtt-qos');
    expect(validateMqttPacket(Uint8Array.of(0x32, 0x05, 0x00, 0x01, 0x61, 0x00, 0x00, 0x62), 2)).toBe('mqtt-publish');
    expect(validateMqttPacket(Uint8Array.of(0x30, 0x02, 0x00, 0x00), 2)).toBe('mqtt-publish');
    expect(validateMqttPacket(Uint8Array.of(0x41, 0x03, 0x00, 0x01, 0x00), 2)).toBe('mqtt-control');
    expect(validateMqttPacket(Uint8Array.of(0xc0, 0x00), 2)).toBe('mqtt-packet-type');
  });
});
