import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';
import type { Translate } from '../i18n/I18nProvider';
import { messagesFor } from '../i18n/locale';
import type { MessageId } from '../i18n/messages.en';
import { deviceName, parseUserAgent } from './device';
import { USER_AGENTS } from './fixtures';

const intl = createIntl({ locale: 'en', messages: messagesFor('en') });
const t: Translate = (id: MessageId, values) => intl.formatMessage({ id }, values);

describe('device names from User-Agent headers', () => {
  it.each([
    [USER_AGENTS.chromeWindows, 'Chrome', 'Windows'],
    [USER_AGENTS.firefoxLinux, 'Firefox', 'Linux'],
    [USER_AGENTS.safariIphone, 'Safari', 'iOS'],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
      'Safari',
      'macOS',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
      'Edge',
      'Windows',
    ],
    [
      'Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
      'Chrome',
      'Android',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
      'Samsung Internet',
      'Android',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1',
      'Chrome',
      'iOS',
    ],
    [
      'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/120.0.0.0',
      'Opera',
      'ChromeOS',
    ],
  ])('[IAM-004] reads %s', (userAgent, browser, os) => {
    expect(parseUserAgent(userAgent)).toEqual({ browser, os });
  });

  it('[IAM-004] names the device in a readable form', () => {
    expect(deviceName(t, USER_AGENTS.firefoxLinux)).toBe('Firefox on Linux');
    expect(deviceName(t, 'curl/8.9.1')).toBe('Unknown device');
    expect(deviceName(t, null)).toBe('Unknown device');
    expect(deviceName(t, 'SomeTool/1.0 (Windows NT 10.0)')).toBe('Windows');
  });
});
