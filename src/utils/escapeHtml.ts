/**
 * Smart Volume Radar - HTML escaping for user/API content in Telegram
 * Prevents XSS when embedding user content in HTML.
 */

export function escapeHtml(str: string): string {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
