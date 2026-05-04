/**
 * Smart Volume Radar - Trading Date Utility
 * Returns the last US trading day (NYSE/NASDAQ) for scan consistency.
 * Phase 1: weekends only; no holiday calendar.
 */

/**
 * Get the last US trading day as YYYY-MM-DD.
 * - Weekend (Sat/Sun) → Friday
 * - Weekday before 16:00 ET → previous weekday
 * - Weekday at/after 16:00 ET → today
 */
export function getLastTradingDay(): string {
    const now = new Date();
    const nyParts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: 'numeric',
        hour12: false,
        weekday: 'long',
    }).formatToParts(now);

    const get = (type: string): string => nyParts.find((p) => p.type === type)?.value ?? '';
    const weekday = get('weekday');
    const hour = parseInt(get('hour'), 10) || 0;
    const year = get('year');
    const month = get('month');
    const day = get('day');

    // Weekend: use Friday
    if (weekday === 'Saturday' || weekday === 'Sunday') {
        const friday = new Date(now);
        const dayOfWeek = friday.getUTCDay();
        const diff = dayOfWeek === 0 ? 2 : dayOfWeek === 6 ? 1 : 0;
        friday.setUTCDate(friday.getUTCDate() - diff);
        return friday.toISOString().slice(0, 10);
    }

    // Weekday before 4pm ET: use previous trading day
    if (hour < 16) {
        const prev = new Date(now);
        prev.setUTCDate(prev.getUTCDate() - 1);
        return prev.toISOString().slice(0, 10);
    }

    // Weekday at/after 4pm ET: use today (NY date from formatToParts)
    return `${year}-${month}-${day}`;
}
