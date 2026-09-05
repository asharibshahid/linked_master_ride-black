const { safeTrim } = require("../utils/text");

function toNumber(value, fallback = 0) {
  const parsed = Number(String(value ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundMoney(value) {
  return Math.round(Math.max(0, Number(value) || 0) * 2) / 2;
}

function createBidAiReviewer(options = {}) {
  const enabled = Boolean(options.enabled && options.apiKey);
  const model = safeTrim(options.model) || "gpt-4.1-mini";
  const maxCallsPerHour = Math.max(1, Math.min(30, Number(options.maxCallsPerHour) || 8));
  const calls = [];
  const cache = new Map();

  function prune(now) {
    while (calls.length && calls[0] < now - 60 * 60 * 1000) calls.shift();
  }

  async function review({ bid = {}, pricing = {} } = {}) {
    if (!enabled) throw new Error("AI bid review is disabled");
    const rideId = safeTrim(bid["Ride ID"] || bid.rideId);
    if (!rideId) throw new Error("Ride ID is required for AI bid review");
    const cacheKey = `${rideId}:${pricing.suggestedBid || bid["Bid Amount"]}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return { ...cached.value, cached: true };

    prune(Date.now());
    if (calls.length >= maxCallsPerHour) {
      throw new Error(`AI bid review limit reached (${maxCallsPerHour}/hour)`);
    }

    // Loaded only after an operator explicitly requests one review.
    // eslint-disable-next-line global-require
    const OpenAI = require("openai");
    const client = new OpenAI({ apiKey: options.apiKey });
    const floor = Math.max(toNumber(pricing.estimatedCost) / 0.8, toNumber(pricing.suggestedBid) * 0.85);
    const ceiling = Math.max(toNumber(bid.Fare || bid.fare), toNumber(pricing.suggestedBid)) * 1.15;
    const response = await client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 120,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You review UK taxi bid estimates. Return JSON only: suggestedBid (number), decision (Ready for Review or Review Required), reason (max 20 words). Never set a bid below the supplied profitable floor."
        },
        {
          role: "user",
          content: JSON.stringify({
            route: `${safeTrim(bid.Pickup)} -> ${safeTrim(bid["Drop Off"])}`,
            vehicle: safeTrim(bid["Required Vehicle"]),
            quotedFare: toNumber(bid.Fare),
            ruleSuggestedBid: toNumber(pricing.suggestedBid),
            estimatedCost: toNumber(pricing.estimatedCost),
            marginPercent: toNumber(pricing.marginPercent),
            profitableFloor: roundMoney(floor),
            maximumReviewBid: roundMoney(ceiling)
          })
        }
      ]
    });
    calls.push(Date.now());
    let parsed = {};
    try {
      parsed = JSON.parse(response.choices?.[0]?.message?.content || "{}");
    } catch {
      throw new Error("AI bid review returned invalid JSON");
    }
    const suggestedBid = roundMoney(Math.min(ceiling, Math.max(floor, toNumber(parsed.suggestedBid, pricing.suggestedBid))));
    const value = {
      suggestedBid,
      decision: safeTrim(parsed.decision) === "Review Required" ? "Review Required" : "Ready for Review",
      reason: safeTrim(parsed.reason) || "AI reviewed the rule-based bid",
      confidence: "AI Reviewed",
      cached: false
    };
    cache.set(cacheKey, { value, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
    return value;
  }

  return { enabled, review };
}

module.exports = { createBidAiReviewer };
