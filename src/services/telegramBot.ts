/**
 * Smart Volume Radar - Telegram Bot Service
 * Sends formatted reports via Telegram Bot API
 */

import { RVOLResult, StockData, TelegramApiError, MonitorEntry, MonitorState } from '../types/index.js';
import { config } from '../config/index.js';
import logger from '../utils/logger.js';
import { escapeHtml } from '../utils/escapeHtml.js';
import { formatTagsForDisplay } from '../utils/tags.js';
import { formatRVOL, formatPriceChange } from '../utils/formatters.js';
// LLM summary feature removed 2026-05-22 — Gemini API key was missing in production
// so the daily LLM commentary block never actually got sent. See decisions-log.md.
// `classifyTickersWithGroq` (the ticker-type utility) is still imported separately in index.ts.
import type { MonitorUpdateSummary } from './monitorTracker.js';

const TELEGRAM_MAX_LENGTH = 4096;
/** Delay between sends to avoid Telegram rate limit (429) when sending many chunks */
const TELEGRAM_SEND_DELAY_MS = 1200;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send a message via Telegram Bot API
 * @param message - HTML formatted message
 */
export async function sendTelegramMessage(message: string): Promise<void> {
    const { telegramBotToken, telegramChatId } = config;

    if (!telegramBotToken || !telegramChatId) {
        logger.warn('Telegram credentials not configured, skipping send');
        logger.info('--- TELEGRAM MESSAGE PREVIEW ---\n' + message.replace(/<[^>]*>/g, '') + '\n--- END PREVIEW ---');
        return;
    }

    const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: telegramChatId,
                text: message,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            }),
        });

        if (!response.ok) {
            const error = (await response.json()) as TelegramApiError & { parameters?: { retry_after?: number } };
            if (response.status === 429 && error.parameters?.retry_after) {
                const waitSec = error.parameters.retry_after;
                logger.warn(`Telegram rate limit (429), waiting ${waitSec}s before retry`);
                await sleep(waitSec * 1000);
                const retryRes = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: telegramChatId,
                        text: message,
                        parse_mode: 'HTML',
                        disable_web_page_preview: true,
                    }),
                });
                if (!retryRes.ok) {
                    const retryErr = (await retryRes.json()) as TelegramApiError;
                    throw new Error(`Telegram API error: ${JSON.stringify(retryErr)}`);
                }
                logger.info('Telegram message sent successfully (after retry)');
                return;
            }
            let errorMessage = `Telegram API error: ${JSON.stringify(error)}`;
            if (error.description === 'Bad Request: chat not found') {
                errorMessage += '\n💡 TIP: Ensure your TELEGRAM_CHAT_ID is correct and the bot has been started by the user or added to the group.';
            }
            throw new Error(errorMessage);
        }

        logger.info('Telegram message sent successfully');
    } catch (error: unknown) {
        logger.error('Failed to send Telegram message', error);
        throw error;
    }
}

function formatReportHeader(
    date: string,
    bullish: number,
    bearish: number,
    regime: 'bull' | 'bear' | undefined,
    actionCounts: { buy: number; watch: number; caution: number },
    topSectors?: Array<{ sector: string; rank: number; median63d: number }>
): string {
    const regimeBadge =
        regime === 'bear' ? ' | 🐻 Bear (SPY<SMA200)' : regime === 'bull' ? ' | 🐂 Bull' : '';
    const actionBits: string[] = [];
    if (actionCounts.buy > 0) actionBits.push(`🟢 ${actionCounts.buy} BUY`);
    if (actionCounts.caution > 0) actionBits.push(`⚠️ ${actionCounts.caution} CAUTION`);
    if (actionCounts.watch > 0) actionBits.push(`👀 ${actionCounts.watch} WATCH`);
    const actionLine = actionBits.length > 0 ? `${actionBits.join(' | ')}\n` : '';

    let sectorLine = '';
    if (topSectors && topSectors.length > 0) {
        const fmt = topSectors
            .map((s) => `#${s.rank} ${escapeHtml(s.sector)} ${s.median63d >= 0 ? '+' : ''}${s.median63d.toFixed(0)}%`)
            .join(' | ');
        sectorLine = `🏭 Top sectors: ${fmt}\n`;
    }

    return (
        `🛰 <b>SMART VOLUME RADAR</b>\n` +
        `📅 <code>${date}</code>${regimeBadge}\n` +
        actionLine +
        sectorLine +
        `🎭 Sentiment: ${bullish} 🟢 | ${bearish} 🔴\n` +
        `<i>🟢 BUY = at pivot + volume confirmed | ⚠️ CAUTION = extended or no volume | 👀 WATCH = setup forming</i>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n\n`
    );
}

function buildStockUrls(stock: RVOLResult): { tvUrl: string; yahooUrl: string; newsUrl: string; newsLabel: string } {
    const isIsraeli = stock.ticker.endsWith('.TA');
    const tvTicker = stock.ticker.replace('.TA', '');
    const encTicker = encodeURIComponent(stock.ticker);
    const encTvTicker = encodeURIComponent(isIsraeli ? 'TASE-' + tvTicker : tvTicker);
    return {
        tvUrl: `https://www.tradingview.com/symbols/${encTvTicker}`,
        yahooUrl: `https://finance.yahoo.com/quote/${encTicker}`,
        newsUrl: isIsraeli
            ? `https://www.bizportal.co.il/searchresult?q=${encodeURIComponent(tvTicker)}`
            : `https://x.com/search?q=%24${encodeURIComponent(tvTicker)}`,
        newsLabel: isIsraeli ? 'BIZ' : 'X',
    };
}

/**
 * Per-stock monitor metadata used to surface persistence markers (🆕 / 🔁N) in the
 * daily report. Built in index.ts from the monitor state, keyed by uppercase ticker.
 */
export interface MonitorMeta {
    /** True when firstAlertDate === scanDate (this is the very first alert for this ticker). */
    isFirstAlertToday: boolean;
    /** Number of re-alert events on this entry (0 = single alert so far). */
    reAlertCount: number;
    /** Calendar days between firstAlertDate and scanDate. */
    daysSinceFirst: number;
}

/** Hebrew labels for momentum criteria — used in the (חסר: ...) failures hint. */
const CRITERIA_LABEL_HE: Record<string, string> = {
    rvolPass: 'נפח (RVOL)',
    stage2: 'מגמה Stage 2',
    pivotBreakout: 'פריצת ATH',
    aboveGapAvwap: 'AVWAP מעל גאפ',
    lowRiskEntry: 'מרחק SMA21',
    tightness: 'תקופת בסיס',
    antsAccumulation: 'אקומולציה (Ants)',
    bigMoveToday: 'תנועת מחיר היום',
};

/** Translate a list of criteria keys to a comma-separated Hebrew label string. */
function criteriaListHe(keys: string[]): string {
    return keys.map((k) => CRITERIA_LABEL_HE[k] ?? k).join(', ');
}

/** Compact ✓/✗ row for the 4 mandatory + 4 quality momentum criteria. */
function formatMomentumCriteriaRows(stock: RVOLResult): string {
    const c = stock.momentum?.criteria;
    if (!c) return '';
    const mark = (b: boolean | undefined): string => (b ? '✓' : '✗');
    const mandatory =
        `RVOL ${mark(c.rvolPass)} | Stage2 ${mark(c.stage2)} | ` +
        `Pivot ${mark(c.pivotBreakout)} | AVWAP ${mark(c.aboveGapAvwap)}`;
    const quality =
        `LowRisk ${mark(c.lowRiskEntry)} | Tight ${mark(c.tightness)} | ` +
        `Ants ${mark(c.antsAccumulation)} | BigMove ${mark(c.bigMoveToday)}`;
    return `├ ✅ <b>Mandatory:</b> ${mandatory}\n├ ⭐ <b>Quality:</b> ${quality}\n`;
}

/** Distance from SMA21 in percent, formatted. Returns null when SMA21 unavailable. */
function formatSma21Distance(stock: RVOLResult): string | null {
    if (stock.sma21 == null || stock.sma21 <= 0 || stock.lastPrice == null) return null;
    const distPct = ((stock.lastPrice - stock.sma21) / stock.sma21) * 100;
    const sign = distPct >= 0 ? '+' : '';
    return `${sign}${distPct.toFixed(1)}%`;
}

/**
 * Render a persistence marker for a stock based on monitor history.
 *  🆕 = first alert today
 *  🔁N = N-th re-alert (N=1+); upgraded to 🔁🔥N at 5+ (per 2026-05-05 finding:
 *  5+ re-alerts had 88% win rate, the highest in the dataset).
 */
function formatPersistenceMarker(meta: MonitorMeta | undefined): string {
    if (!meta) return '';
    if (meta.isFirstAlertToday) return ' 🆕';
    if (meta.reAlertCount === 0) return '';
    const heat = meta.reAlertCount >= 5 ? '🔁🔥' : '🔁';
    return ` ${heat}${meta.reAlertCount}`;
}

/**
 * Format up to 2 most recent news headlines, dimmed and compact.
 * Empty string when news is missing or empty.
 */
function formatNewsLines(stock: RVOLResult): string {
    if (!stock.news || stock.news.length === 0) return '';
    const recent = [...stock.news]
        .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
        .slice(0, 2);
    const now = Date.now();
    const lines = recent.map((n) => {
        const ageHours = (now - n.publishedAt.getTime()) / 3_600_000;
        const ageStr = ageHours < 24 ? `${ageHours.toFixed(0)}h` : `${(ageHours / 24).toFixed(0)}d`;
        const headline = n.headline.length > 80 ? n.headline.slice(0, 77) + '…' : n.headline;
        return `├ 📰 <a href="${escapeHtml(n.url)}">${escapeHtml(headline)}</a> · <i>${ageStr} · ${escapeHtml(n.source)}</i>`;
    });
    return lines.join('\n') + '\n';
}

/** Hebrew descriptor for breakout stage. */
function breakoutStageLabel(stage: NonNullable<RVOLResult['breakoutStage']>): string {
    switch (stage) {
        case 'Breaking Out':
            return 'Breaking Out (פריצה היום)';
        case 'Fresh':
            return 'Fresh (פריצה טרייה)';
        case 'Aging':
            return 'Aging (פריצה ישנה — נמצא במגמה)';
        case 'Pre-Pivot':
            return 'Pre-Pivot (קרוב לפיבוט, מתבסס)';
        case 'Setup':
            return 'Setup (בתוך בסיס)';
        case 'Failed':
            return 'Failed (פריצה כשלה)';
    }
}

function formatSingleStockBlock(stock: RVOLResult, monitorMeta?: MonitorMeta): string {
    let statusEmoji = stock.priceChange >= 0 ? '↗️' : '↘️';
    if (stock.rvol > 4) statusEmoji = '⚡️';
    else if (stock.rvol > 2) statusEmoji = '🔥';

    const trendColor = stock.priceChange >= 0 ? '🟢' : '🔴';
    const { tvUrl, yahooUrl } = buildStockUrls(stock);
    const persistenceMarker = formatPersistenceMarker(monitorMeta);

    // Header: ticker + persistence + Champion Score + RS percentile + sector
    let block = `${statusEmoji} <b><a href="${tvUrl}">${escapeHtml(stock.ticker)}</a></b>${persistenceMarker}`;
    if (stock.championScore != null) {
        block += `  <b>${stock.championScore.toFixed(0)}</b><i>/100</i>`;
    }
    if (stock.rsPercentile != null) {
        block += `  ·  <b>RS</b> ${stock.rsPercentile}`;
    }
    if (stock.sector) {
        let sectorTag = stock.sector;
        // Phase 4B: append rank + 63d median return when available.
        if (stock.sectorRank != null && stock.sectorMedianReturn63d != null) {
            const sign = stock.sectorMedianReturn63d >= 0 ? '+' : '';
            sectorTag += ` #${stock.sectorRank} ${sign}${stock.sectorMedianReturn63d.toFixed(0)}%`;
        }
        block += ` <i>(${escapeHtml(sectorTag)})</i>`;
    }
    block += '\n';

    // Action-specific narrative line: tells the user WHY this action.
    if (stock.action === 'CAUTION_DISTRIBUTION') {
        block += `├ 🔻 <i>${stock.distributionDays ?? 0} distribution days — לחץ מכירה מוסדי</i>\n`;
    } else if (stock.action === 'CAUTION_EXTENDED' && stock.tradePlan) {
        block += `├ ⚠️ <i>extended ${stock.tradePlan.extensionPct.toFixed(1)}% מעבר ל-pivot — סטופ הדוק</i>\n`;
    } else if (stock.action === 'CAUTION_NO_VOL') {
        block += `├ ⚠️ <i>על ה-pivot אבל RVOL ${formatRVOL(stock.rvol)} — נפח לא מאשר</i>\n`;
    } else if (stock.action === 'WATCH' && stock.tradePlan) {
        block += `├ 👀 <i>צריך עוד ${stock.tradePlan.distanceToEntryPct.toFixed(1)}% עד ה-pivot</i>\n`;
    }

    // Trade plan: pivot, buy zone, stop loss, risk %
    if (stock.tradePlan) {
        const tp = stock.tradePlan;
        block +=
            `├ 🎯 <b>Buy zone</b>: $${tp.buyZoneLow.toFixed(2)}–$${tp.buyZoneHigh.toFixed(2)}` +
            ` <i>(pivot $${tp.pivot.toFixed(2)})</i>\n`;
        if (tp.stopLoss != null && tp.riskPct != null) {
            block += `├ 🛑 <b>Stop</b> $${tp.stopLoss.toFixed(2)}  ·  <b>Risk</b> ${tp.riskPct.toFixed(1)}%\n`;
        }
    }

    // Breakout stage
    if (stock.breakoutStage) {
        block += `├ 📊 <b>Stage:</b> ${escapeHtml(breakoutStageLabel(stock.breakoutStage))}\n`;
    }

    // Recovery / Watchlist context (preserved from prior format — additive)
    if (stock.momentum?.level === 'recovery') {
        block += `├ 🦅 <i>Recovery: SMA200 עוד למטה — סיכון/סיכוי גבוה</i>\n`;
    } else if (stock.momentum?.level === 'close' && stock.action !== 'BUY') {
        const reasons = criteriaListHe(stock.momentum.failures.slice(0, 3));
        if (reasons) {
            block += `├ 👀 <i>חסר: ${escapeHtml(reasons)}</i>\n`;
        }
    }

    // Criteria checklist — only for non-BUY actions (BUY already action-confirmed).
    if (stock.action !== 'BUY' && stock.momentum?.level !== 'full') {
        block += formatMomentumCriteriaRows(stock);
    }

    // Core metrics
    block += `├ 📊 <b>RVOL</b> ${formatRVOL(stock.rvol)}`;
    if (stock.projectedRvol != null && Math.abs(stock.projectedRvol - stock.rvol) > 0.05) {
        block += ` <i>(proj ${formatRVOL(stock.projectedRvol)})</i>`;
    }
    block += '\n';
    block += `├ <b>Price</b> ${trendColor} ${formatPriceChange(stock.priceChange)} <i>($${stock.lastPrice.toFixed(2)})</i>\n`;

    if (stock.rsi != null) {
        const rsiContext = stock.rsi > 70 ? ' ⚠️ קניית יתר' : stock.rsi < 30 ? ' ✅ מכירת יתר' : '';
        block += `├ 📈 <b>RSI</b> ${stock.rsi.toFixed(0)}${rsiContext}\n`;
    }

    // Trend stack (Stage 2 picture). Use ↑/↓ instead of </> which Telegram parses as HTML tags.
    const trendBits: string[] = [];
    if (stock.sma50 != null) {
        trendBits.push(stock.lastPrice > stock.sma50 ? 'Price ↑ SMA50' : 'Price ↓ SMA50');
    }
    if (stock.sma200 != null && stock.sma50 != null) {
        trendBits.push(stock.sma50 > stock.sma200 ? 'SMA50 ↑ SMA200' : 'SMA50 ↓ SMA200');
    }
    if (stock.sma200Slope) {
        const arrow = stock.sma200Slope === 'up' ? '↗' : stock.sma200Slope === 'down' ? '↘' : '→';
        trendBits.push(`SMA200 ${arrow}${stock.sma200Slope}`);
    }
    if (trendBits.length > 0) {
        block += `├ 📉 ${trendBits.join(' | ')}\n`;
    }

    // Distance metrics — show all that are available, using actual distFrom percentages.
    const sma21Dist = formatSma21Distance(stock);
    const distBits: string[] = [];
    if (sma21Dist) distBits.push(`SMA21 ${sma21Dist}`);
    if (stock.pctFromAth != null) distBits.push(`ATH ${stock.pctFromAth.toFixed(1)}%`);
    if (stock.daysSinceAth != null) distBits.push(`${stock.daysSinceAth}d since ATH`);
    if (distBits.length > 0) {
        block += `├ 📐 ${escapeHtml(distBits.join(' | '))}\n`;
    }

    // Phase 2: Accumulation/Distribution day counts (institutional volume signature)
    if (
        (stock.accumulationDays ?? 0) >= 3 ||
        (stock.distributionDays ?? 0) >= 3
    ) {
        const acc = stock.accumulationDays ?? 0;
        const dist = stock.distributionDays ?? 0;
        const verdict =
            dist >= 4 ? '🔻 Distribution (institutional selling)'
                : acc >= dist ? '✅ Accumulation'
                    : '⚠️ Mixed';
        block += `├ 📊 <b>A/D:</b> ${acc}↑ / ${dist}↓ <i>(${verdict})</i>\n`;
    }

    // Phase 3: Earnings warning (≤7 days = elevated risk)
    if (stock.daysToEarnings != null && stock.daysToEarnings >= 0 && stock.daysToEarnings <= 7) {
        const dateStr = stock.nextEarningsDate ? ` (${stock.nextEarningsDate})` : '';
        const urgency = stock.daysToEarnings <= 2 ? '⚠️ ⚠️' : '⚠️';
        block += `├ 📅 <b>Earnings in ${stock.daysToEarnings}d</b>${dateStr} ${urgency} <i>elevated risk</i>\n`;
    }

    // Phase 3: EPS / Revenue acceleration (institutional money rule of thumb)
    if (stock.epsAcceleration || stock.revAcceleration) {
        const sym = (t: typeof stock.epsAcceleration): string =>
            t === 'accelerating' ? '▲' : t === 'decelerating' ? '▼' : t === 'flat' ? '→' : '—';
        const epsLabel = stock.epsAcceleration ? `EPS ${sym(stock.epsAcceleration)} ${stock.epsAcceleration}` : null;
        const revLabel = stock.revAcceleration ? `Rev ${sym(stock.revAcceleration)} ${stock.revAcceleration}` : null;
        const parts = [epsLabel, revLabel].filter(Boolean).join(' | ');
        block += `├ 💰 <b>Fundamentals:</b> ${parts}\n`;
    }

    // Phase 2: Bollinger Band squeeze flag (volatility contraction = pre-breakout coil)
    if (
        stock.bbUpper != null &&
        stock.bbLower != null &&
        stock.lastPrice > 0 &&
        (stock.bbUpper - stock.bbLower) / stock.lastPrice < 0.05
    ) {
        const widthPct = ((stock.bbUpper - stock.bbLower) / stock.lastPrice) * 100;
        block += `├ 🔒 <b>BB squeeze</b> <i>(width ${widthPct.toFixed(1)}% — coil before breakout)</i>\n`;
    }

    // Quality flags
    if (stock.momentum?.criteria.antsAccumulation) {
        const greenDays = stock.consecutiveGreenDays ?? 0;
        block += `├ 🐜 <i>Ants accumulation${greenDays > 0 ? ` (${greenDays} green days)` : ''}</i>\n`;
    }
    if (stock.gapDay && stock.avwapFromGap != null) {
        const gapDir = stock.lastPrice >= stock.avwapFromGap ? '✓ above' : '✗ below';
        block += `├ ⛳ Gap day ${stock.gapDay.barsAgo}d ago — AVWAP ${gapDir} ($${stock.avwapFromGap.toFixed(2)})\n`;
    }

    // Existing tags (informational only — entry already determined by momentum)
    const tagStr = formatTagsForDisplay(stock);
    if (tagStr) {
        block += `├ 🏷 ${escapeHtml(tagStr)}\n`;
    }

    // News — render the 2 most recent Finnhub headlines if enriched
    block += formatNewsLines(stock);

    block += `└ ⛓ <a href="${tvUrl}">TV</a>  <a href="${yahooUrl}">YF</a>\n\n`;
    return block;
}

/**
 * Split message into chunks that fit Telegram's limit
 */
function chunkMessage(message: string, maxLen: number = TELEGRAM_MAX_LENGTH): string[] {
    if (message.length <= maxLen) {
        return [message];
    }

    const chunks: string[] = [];
    const lines = message.split('\n');
    let currentChunk = '';

    for (const line of lines) {
        if (currentChunk.length + line.length + 1 > maxLen) {
            if (currentChunk) {
                chunks.push(currentChunk.trim());
            }
            currentChunk = line + '\n';
        } else {
            currentChunk += line + '\n';
        }
    }

    if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
    }

    return chunks;
}

/**
 * Format the daily report message
 */
export function formatDailyReport(
    date: string,
    topSignals: RVOLResult[],
    volumeWithoutPrice: StockData[],
    _failedTickers: string[] = [],
    graduations?: GraduationInfo[],
    monitorMetaByTicker?: Map<string, MonitorMeta>
): string {
    const gradSection = formatGraduationSection(graduations);
    if (topSignals.length === 0) {
        const empty = `📊 <b>Smart Volume Radar</b>\n📅 ${date}\n\n📭 אין מניות אקטיביות היום (BUY / WATCH / CAUTION).\n\n<i>הסורק רץ תקין — פשוט אין כיום מניה שעוברת את הקריטריונים.</i>`;
        return gradSection ? gradSection + empty : empty;
    }

    // Caller already sorted by action rank then score — preserve that.
    const bullish = topSignals.filter((s) => s.priceChange > 0).length;
    const bearish = topSignals.filter((s) => s.priceChange < 0).length;
    const regime = topSignals.find((s) => s.marketRegime)?.marketRegime;

    // Two-tier split (2026-05-10):
    //   PRIMARY → full per-stock blocks: BUY, WATCH, CAUTION_EXTENDED
    //   NOTABLE → compact one-liners: CAUTION_NO_VOL, CAUTION_DISTRIBUTION
    // This lets the report surface ~50+ relevant stocks without flooding.
    const actionBuckets: Record<'BUY' | 'CAUTION_EXT' | 'WATCH', RVOLResult[]> = {
        BUY: [],
        CAUTION_EXT: [],
        WATCH: [],
    };
    const notableNoVol: RVOLResult[] = [];
    const notableDistribution: RVOLResult[] = [];
    for (const stock of topSignals) {
        if (stock.action === 'BUY') actionBuckets.BUY.push(stock);
        else if (stock.action === 'CAUTION_EXTENDED') actionBuckets.CAUTION_EXT.push(stock);
        else if (stock.action === 'WATCH') actionBuckets.WATCH.push(stock);
        else if (stock.action === 'CAUTION_NO_VOL') notableNoVol.push(stock);
        else if (stock.action === 'CAUTION_DISTRIBUTION') notableDistribution.push(stock);
    }
    const actionCounts = {
        buy: actionBuckets.BUY.length,
        watch: actionBuckets.WATCH.length,
        caution: actionBuckets.CAUTION_EXT.length + notableNoVol.length + notableDistribution.length,
    };

    // Top sectors line — derived from stocks that have sectorRank populated.
    const seenSectors = new Set<string>();
    const topSectors: Array<{ sector: string; rank: number; median63d: number }> = [];
    for (const s of topSignals) {
        if (
            s.sector &&
            s.sectorRank != null &&
            s.sectorMedianReturn63d != null &&
            !seenSectors.has(s.sector) &&
            s.sectorRank <= 3
        ) {
            topSectors.push({
                sector: s.sector,
                rank: s.sectorRank,
                median63d: s.sectorMedianReturn63d,
            });
            seenSectors.add(s.sector);
        }
    }
    topSectors.sort((a, b) => a.rank - b.rank);

    let message = formatReportHeader(date, bullish, bearish, regime, actionCounts, topSectors);
    if (gradSection) {
        message = gradSection + message;
    }

    const actionHeaders = {
        BUY: '🟢 <b>BUY</b> <i>(at pivot + volume confirmed)</i>',
        CAUTION_EXT: '⚠️ <b>CAUTION — EXTENDED</b> <i>(past pivot — risky entry)</i>',
        WATCH: '👀 <b>WATCH</b> <i>(setup forming — pre-pivot)</i>',
    } as const;
    for (const action of ['BUY', 'CAUTION_EXT', 'WATCH'] as const) {
        const bucket = actionBuckets[action];
        if (bucket.length === 0) continue;
        message += `${actionHeaders[action]}  ·  ${bucket.length}\n━━━━━━━━━━━━━━━━━━━━━━\n`;
        for (const stock of bucket) {
            const meta = monitorMetaByTicker?.get(stock.ticker.toUpperCase());
            message += formatSingleStockBlock(stock, meta);
        }
    }

    // Tier 2 — notable but cautious (one line per stock).
    message += formatNotableSection(notableDistribution, notableNoVol);

    // Silent activity / PASS / TOO LATE intentionally omitted — Telegram is action-only.
    return message;
}

/**
 * Render the "Notable but Cautious" tier — compact one-liners for high-score
 * stocks that don't qualify as actionable today (under distribution or lacking
 * volume confirmation). Two sub-sections, sorted by score descending.
 */
// Spam-fix thresholds (2026-05-22) — see decisions-log.
// Empirical context: cabinet/knowledge/reference/smart-volume-radar-criteria-empirical.md
const NOTABLE_MAX_PER_BUCKET = 5;        // Cap each sub-section to its top-N by score.
const NOTABLE_MIN_SCORE = 60;            // Drop low-quality candidates entirely.
const NOTABLE_SKIP_NEGATIVE_SECTOR = true; // Skip stocks whose sector is in 63d-negative.

/** Empirically (60d study) stocks in negative-sector cohorts have:
 *  - 24% hit rate (vs 65% overall)
 *  - −9.8% median return (Aerospace & Defense baseline)
 *  Excluding them is more truthful than warning about them. */
function isNegativeSector(s: RVOLResult): boolean {
    return s.sectorMedianReturn63d != null && s.sectorMedianReturn63d < 0;
}

function formatNotableSection(
    distributionStocks: RVOLResult[],
    noVolStocks: RVOLResult[]
): string {
    if (distributionStocks.length === 0 && noVolStocks.length === 0) return '';

    const byScore = (a: RVOLResult, b: RVOLResult): number =>
        (b.championScore ?? 0) - (a.championScore ?? 0) || (b.rvol ?? 0) - (a.rvol ?? 0);

    /** Quality filter: drop low-score and (optionally) negative-sector candidates,
     *  then cap to top-N by score. Returns the survivors. */
    const filterBucket = (stocks: RVOLResult[]): RVOLResult[] =>
        stocks
            .filter((s) => (s.championScore ?? 0) >= NOTABLE_MIN_SCORE)
            .filter((s) => !(NOTABLE_SKIP_NEGATIVE_SECTOR && isNegativeSector(s)))
            .sort(byScore)
            .slice(0, NOTABLE_MAX_PER_BUCKET);

    const filteredDist = filterBucket(distributionStocks);
    const filteredNoVol = filterBucket(noVolStocks);

    if (filteredDist.length === 0 && filteredNoVol.length === 0) return '';

    const fmtLine = (s: RVOLResult): string => {
        const score = (s.championScore ?? 0).toFixed(0);
        const stage = s.breakoutStage ?? '?';
        const rvol = (s.rvol ?? 0).toFixed(2);
        const sector = s.sector ? ` · ${escapeHtml(s.sector.slice(0, 20))}` : '';
        const { tvUrl } = buildStockUrls(s);
        return `  • <a href="${tvUrl}"><b>${escapeHtml(s.ticker)}</b></a> ${score}/100 · ${escapeHtml(stage)} · RVOL ${rvol}x${sector}`;
    };

    // Headline counts reflect what was DROPPED to give honest sense of the broader set.
    const distDropped = distributionStocks.length - filteredDist.length;
    const noVolDropped = noVolStocks.length - filteredNoVol.length;
    const totalShown = filteredDist.length + filteredNoVol.length;
    const totalDropped = distDropped + noVolDropped;

    let section = `\n⚠️ <b>NOTABLE BUT CAUTIOUS</b>  ·  ${totalShown} shown`;
    if (totalDropped > 0) section += ` <i>(${totalDropped} filtered out)</i>`;
    section += `\n<i>top score ≥${NOTABLE_MIN_SCORE}, max ${NOTABLE_MAX_PER_BUCKET} per bucket, neg-sector skipped</i>\n`;
    section += `━━━━━━━━━━━━━━━━━━━━━━\n`;

    if (filteredDist.length > 0) {
        section += `\n🔴 <b>Distribution pressure</b> <i>(מוסדיים מוכרים)</i> · ${filteredDist.length}\n`;
        for (const s of filteredDist) section += fmtLine(s) + '\n';
    }
    if (filteredNoVol.length > 0) {
        section += `\n📊 <b>No-Volume confirmation</b> <i>(על פיבוט אבל נפח חלש)</i> · ${filteredNoVol.length}\n`;
        for (const s of filteredNoVol) section += fmtLine(s) + '\n';
    }
    return section;
}

/**
 * Format legend explaining each field, source (API vs calculated), and calculation method
 */
export function formatLegend(): string {
    return `📖 <b>Field Guide</b>

<b>From APIs:</b>
• <b>Price, Volume</b> – Yahoo / Twelve Data
• <b>RSI, SMA21</b> – Twelve Data (if API key set), else calculated
• <b>52w high</b> – Twelve Data (fallback only)
• <b>News</b> – Finnhub

<b>Calculated locally:</b>
• <b>RVOL</b> = today's volume ÷ 63-day avg volume
• <b>Price Change %</b> = (close − prev close) ÷ prev close × 100
• <b>SMA50, SMA200</b> = SMA of last 50/200 closes
• <b>52w high</b> = max of last 252 trading days (Yahoo / Twelve Data)
• <b>pctFromAth</b> = (price − ATH) ÷ ATH × 100
• <b>monthsInConsolidation</b> = days since ATH touch ÷ 21

<b>Tags:</b> SMA21 Touch, Pullback 15%, 1M Breakout`;
}

/** Shared row format: TICKER | RVOL X.XXx | Price ±X.XX% | RSI XX | Setup (code + LLM use same structure) */
const STOCK_ROW_FORMAT = 'TICKER | RVOL X.XXx | Price ±X.XX% | RSI XX | Tags';

// formatStockRow, getStocksForLlm, getAllSignalRows, getSetupRowsFromData,
// formatSetupReference — removed 2026-05-22 with the LLM cleanup. They were
// only consumed by buildLlmSummaryMessage which itself was removed.

/**
 * Format a data header line for every Telegram message (date, stats, part).
 */
function formatMessageDataHeader(
    date: string,
    topSignalsCount: number,
    volumeWithoutPriceCount: number,
    partLabel?: string
): string {
    const parts: string[] = [`📅 ${date}`];
    if (topSignalsCount > 0) parts.push(`${topSignalsCount} signals`);
    if (volumeWithoutPriceCount > 0) parts.push(`${volumeWithoutPriceCount} silent`);
    if (partLabel) parts.push(partLabel);
    return `📊 <code>${parts.join(' • ')}</code>\n\n`;
}

/**
 * One graduation event = a stock that transitioned Watchlist→Full today.
 * Highest-confidence signal in the system per 2026-05-05 criteria analysis
 * (median +24% return vs +2-7% for any other resolution status).
 */
export interface GraduationInfo {
    ticker: string;
    sector?: string;
    firstAlertDate: string;
    firstAlertPrice: number;
    currentPrice: number;
    daysSinceAlert: number;
    returnPct: number;
}

/** Scope info for LLM verification and run issues */
export interface ReportScope {
    watchlistCount?: number;
    invalidTickers?: string[];
    /** Indices skipped – not supported, not sent to Jules */
    indexTickers?: string[];
    /** Tickers where SMA21 Touch could not be evaluated (missing sma21 or lastPrice) */
    sma21TouchSkippedTickers?: string[];
    /** Summary stats for watchlist coverage */
    watchlistStats?: {
        totalInSheet: number;
        analyzed: number;
        notAnalyzed: number;
        reasonInvalid: number;
        reasonIndex: number;
        reasonFetchFailed: number;
    };
    /** Stocks that graduated today (Watchlist→Full). Surfaced at top of report. */
    graduations?: GraduationInfo[];
    /** Per-ticker monitor metadata (🆕/🔁N markers) — keyed by uppercase ticker. */
    monitorMetaByTicker?: Map<string, MonitorMeta>;
}

/**
 * Format the graduation block — the highest-priority section of the report.
 * Empty string when no graduations today.
 */
function formatGraduationSection(graduations: GraduationInfo[] | undefined): string {
    if (!graduations || graduations.length === 0) return '';
    const lines: string[] = [];
    lines.push(
        `🎓 <b>GRADUATION ALERT (${graduations.length})</b>  <i>Watchlist → Full Momentum</i>`
    );
    lines.push('━━━━━━━━━━━━━━━━━━━━━━');
    for (const g of graduations) {
        const sector = g.sector ? ` <i>(${escapeHtml(g.sector)})</i>` : '';
        const sign = g.returnPct >= 0 ? '+' : '';
        lines.push(
            `🎯 <b>${escapeHtml(g.ticker)}</b>${sector}\n` +
                `├ ${sign}${g.returnPct.toFixed(1)}% מהאיתות הראשון  ` +
                `($${g.firstAlertPrice.toFixed(2)} → $${g.currentPrice.toFixed(2)})\n` +
                `└ ${g.daysSinceAlert} ימים מאיתות Watchlist`
        );
    }
    lines.push(
        `\n<i>📊 גרדואציה היא הסיגנל החזק ביותר ההיסטורית: median +24% תשואה ` +
            `(לעומת +2-7% לסטטוסים אחרים, n=15 ב-30 ימים האחרונים).</i>\n`
    );
    lines.push('━━━━━━━━━━━━━━━━━━━━━━\n');
    return lines.join('\n');
}

/** Format watchlist summary: total in sheet, analyzed, not analyzed with reasons */
function formatWatchlistSummary(stats: ReportScope['watchlistStats']): string {
    if (!stats || stats.totalInSheet === 0) return '';
    const reasons: string[] = [];
    if (stats.reasonInvalid > 0) reasons.push(`פורמט לא נתמך: ${stats.reasonInvalid}`);
    if (stats.reasonIndex > 0) reasons.push(`אינדקסים: ${stats.reasonIndex}`);
    if (stats.reasonFetchFailed > 0) reasons.push(`שליפה נכשלה: ${stats.reasonFetchFailed}`);
    const reasonsStr = reasons.length > 0 ? ` (${reasons.join(' | ')})` : '';
    return `📋 <b>רשימה:</b> ${stats.totalInSheet} מניות | ✅ נותחו: ${stats.analyzed} | ⏭️ לא נותחו: ${stats.notAnalyzed}${reasonsStr}\n\n`;
}

/** Format run issues (invalid format, indices, failed fetch) for visibility in first message */
function formatRunIssuesSection(
    invalidTickers: string[],
    failedTickers: string[],
    indexTickers: string[] = [],
    watchlistStats?: ReportScope['watchlistStats'],
    sma21TouchSkippedTickers: string[] = []
): string {
    const summary = formatWatchlistSummary(watchlistStats);
    const parts: string[] = [];
    if (invalidTickers.length > 0) {
        parts.push(`⚠️ <b>פורמט לא נתמך (דולגו):</b> <code>${invalidTickers.map((t) => escapeHtml(t)).join(', ')}</code>`);
    }
    if (indexTickers.length > 0) {
        parts.push(`📊 <b>אינדקסים (לא נתמכים — אין volume):</b> <code>${indexTickers.map((t) => escapeHtml(t)).join(', ')}</code>`);
    }
    if (failedTickers.length > 0) {
        parts.push(
            `⚠️ <b>לא הצלחנו לשלוף נתונים:</b> <code>${failedTickers.map((t) => escapeHtml(t)).join(', ')}</code>\n<i>(בדקו שגיאות כתיב (למשל COBE במקום CBOE), אם הסימול נמחק, חסרה סיומת בורסה (.L, .TA) או פורמט שגוי (למשל BRK.B במקום BRK-B))</i>`
        );
    }
    if (sma21TouchSkippedTickers.length > 0) {
        parts.push(`⚠️ <b>SMA21 Touch לא חושב (חסר נתונים):</b> <code>${sma21TouchSkippedTickers.map((t) => escapeHtml(t)).join(', ')}</code>`);
    }
    if (summary === '' && parts.length === 0) return '';
    const body = parts.length > 0 ? '\n' + parts.join('\n') : '';
    return `━━━━━━━━━━━━━━━━━━━━━━\n${summary}${body}\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
}

/**
 * Send the daily report, splitting if necessary.
 * Every message includes a data header (date, stats, part).
 *
 * Note: the LLM summary block was removed 2026-05-22 (Gemini API key was
 * missing in production, so the feature never actually shipped commentary).
 * Issues section now goes in the first chunk.
 */
export async function sendDailyReport(
    date: string,
    topSignals: RVOLResult[],
    volumeWithoutPrice: StockData[],
    failedTickers: string[] = [],
    scope?: ReportScope
): Promise<void> {
    const report = formatDailyReport(
        date,
        topSignals,
        volumeWithoutPrice,
        failedTickers,
        scope?.graduations,
        scope?.monitorMetaByTicker
    );
    const chunks = chunkMessage(report);

    const issuesSection = formatRunIssuesSection(
        scope?.invalidTickers ?? [],
        failedTickers,
        scope?.indexTickers ?? [],
        scope?.watchlistStats,
        scope?.sma21TouchSkippedTickers ?? []
    );

    logger.info(`Sending report (${chunks.length} part(s)) to Telegram`);

    for (let i = 0; i < chunks.length; i++) {
        if (i > 0) await sleep(TELEGRAM_SEND_DELAY_MS);
        const partLabel = chunks.length > 1 ? `Part ${i + 1}/${chunks.length}` : undefined;
        const msgDataHeader = formatMessageDataHeader(date, topSignals.length, volumeWithoutPrice.length, partLabel);
        const prefix = i === 0 && issuesSection ? issuesSection + msgDataHeader : msgDataHeader;
        const content = prefix + chunks[i];
        const toSend = chunkMessage(content);
        for (let j = 0; j < toSend.length; j++) {
            if (j > 0) await sleep(TELEGRAM_SEND_DELAY_MS);
            await sendTelegramMessage(toSend[j]!);
        }
    }
}

// ─── Monitor / Followup Telegram formatter ──────────────────────────────

/** Format the price-change since first alert, given current price. */
function formatMonitorReturn(entry: MonitorEntry, currentPrice: number | undefined): string {
    if (!currentPrice || entry.firstAlertPrice <= 0) return '';
    const ret = ((currentPrice - entry.firstAlertPrice) / entry.firstAlertPrice) * 100;
    const sign = ret >= 0 ? '+' : '';
    return `${sign}${ret.toFixed(1)}%`;
}

/** Trading-day distance helper (Mon-Fri only). */
function calendarDaysSince(fromIso: string, toIso: string): number {
    return Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86400_000));
}

/**
 * Build a separate Telegram message for the monitor follow-up.
 * Returns null if there's nothing actionable AND no active monitors (no point pinging).
 *
 * Sections:
 *   🚨 ACTIONABLE TODAY  — graduations, manual-entries, sma21-pullbacks
 *   🆕 NEW MONITORS      — added this scan
 *   👀 ACTIVE            — count + top-N by recent activity
 *   🗑️ EXPIRED          — removed today
 */
export function formatMonitorTelegramMessage(
    summary: MonitorUpdateSummary,
    state: MonitorState,
    asOfDate: string,
    stocksByTicker: Map<string, StockData>
): string | null {
    const actionable = summary.transitions.filter((t) =>
        ['graduated', 'manual-entry', 'sma21-pullback'].includes(t.newStatus ?? '')
    );
    const expired = summary.transitions.filter((t) => t.newStatus === 'expired');
    const active = state.entries.filter((e) => e.status === 'monitoring');

    // Skip if nothing happened AND no active monitors.
    if (
        actionable.length === 0 &&
        summary.newEntries.length === 0 &&
        expired.length === 0 &&
        active.length === 0
    ) {
        return null;
    }

    const parts: string[] = [];
    parts.push(`📊 <b>MONITOR FOLLOWUP</b>\n📅 <code>${asOfDate}</code>\n━━━━━━━━━━━━━━━━━━━━━━`);

    // 1. Actionable — the most important section.
    if (actionable.length > 0) {
        parts.push(`\n🚨 <b>ACTIONABLE TODAY (${actionable.length})</b>`);
        for (const t of actionable) {
            const e = t.entry;
            const stock = stocksByTicker.get(e.ticker.toUpperCase());
            const ret = formatMonitorReturn(e, stock?.lastPrice);
            const days = calendarDaysSince(e.firstAlertDate, asOfDate);
            const emoji =
                t.newStatus === 'graduated' ? '🎓🎯'
                    : t.newStatus === 'manual-entry' ? '🟢'
                        : '📐';
            const statusLabel =
                t.newStatus === 'graduated' ? 'גרדואציה ל-Full'
                    : t.newStatus === 'manual-entry' ? 'כניסה ידנית מאושרת'
                        : 'פולבק נקי ל-SMA21';
            parts.push(
                `${emoji} <b>${escapeHtml(e.ticker)}</b> — ${escapeHtml(statusLabel)}\n` +
                `   ₪/$${e.firstAlertPrice.toFixed(2)} → $${(stock?.lastPrice ?? 0).toFixed(2)}  ` +
                `(${escapeHtml(ret)} ב-${days}d)\n` +
                `   <i>${escapeHtml(t.reason ?? '')}</i>`
            );
        }
    }

    // 2. New monitors.
    if (summary.newEntries.length > 0) {
        const sortOrder: Record<string, number> = { full: 0, recovery: 1, close: 2 };
        const sorted = [...summary.newEntries].sort(
            (a, b) => sortOrder[a.firstAlertLevel] - sortOrder[b.firstAlertLevel]
        );
        const fullCount = sorted.filter((e) => e.firstAlertLevel === 'full').length;
        const recoveryCount = sorted.filter((e) => e.firstAlertLevel === 'recovery').length;
        const closeCount = sorted.filter((e) => e.firstAlertLevel === 'close').length;
        parts.push(
            `\n🆕 <b>NEW MONITORS (${summary.newEntries.length})</b> — ` +
            `🎯${fullCount} 🦅${recoveryCount} 👀${closeCount}`
        );
        // Show only top 10 to keep message size manageable.
        for (const e of sorted.slice(0, 10)) {
            const lvEmoji =
                e.firstAlertLevel === 'full' ? '🎯'
                    : e.firstAlertLevel === 'recovery' ? '🦅'
                        : '👀';
            const sector = e.sector ? ` · ${escapeHtml(e.sector.slice(0, 18))}` : '';
            parts.push(
                `${lvEmoji} <b>${escapeHtml(e.ticker)}</b> @ $${e.firstAlertPrice.toFixed(2)}  ` +
                `RVOL ${e.firstAlertRvol.toFixed(2)}${sector}`
            );
        }
        if (sorted.length > 10) {
            parts.push(`<i>...ועוד ${sorted.length - 10} מניות</i>`);
        }
    }

    // 3. Active monitors summary (count only — full list is in the JSON).
    parts.push(
        `\n👀 <b>STILL MONITORING:</b> ${active.length} מניות פעילות` +
        ` | <b>סך כל אי-פעם:</b> ${state.entries.length}`
    );

    // 4. Expired (rarely shows; informational).
    if (expired.length > 0) {
        parts.push(
            `\n🗑️ <b>EXPIRED TODAY:</b> ${expired.length} מניות עברו 30 ימים ללא resolution: ` +
            expired.slice(0, 5).map((t) => escapeHtml(t.entry.ticker)).join(', ') +
            (expired.length > 5 ? `, +${expired.length - 5}` : '')
        );
    }

    return parts.join('\n');
}
