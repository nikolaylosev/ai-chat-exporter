import { errorCode, userMessage, type ErrorCode } from './errors';
import { t } from './i18n';

/** The message for an error code alone, e.g. for a code that comes without an error. */
export function codeText(code: ErrorCode): string {
  return t(`error_${code.replace(/-/g, '_')}`);
}

/**
 * An error in the UI language. A failure without a code shows its reason; a
 * format change names the field that changed, so a report can be acted on.
 */
export function errorText(error: unknown): string {
  const code = errorCode(error);
  if (code === 'failed') return t('error_failed', userMessage(error));
  if (code === 'format-changed') return t('error_format_changed_at', userMessage(error));
  return codeText(code);
}
