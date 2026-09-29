/**
 * Time-throttled progress reporting.
 *
 * A big download calls its progress callback once per 32 MB chunk — roughly
 * every three seconds here, which would flood the chat. The rule this encodes is
 * the user's: **report every 10-20 seconds**, whatever the byte count. So the
 * throttle keys on the clock, not on the payload.
 *
 * Pure apart from the injected clock, so the cadence is unit-tested instead of
 * being tuned by watching a real download.
 *
 * @module dsh-feishu/progress
 */

/**
 * Build a reporter that only lets a message through every `intervalMs`.
 *
 * The first call is swallowed too: the caller has normally already told the user
 * that work started, so an immediate "0%" would just be noise.
 *
 * @param {object} options - the throttle.
 * @param {number} options.intervalMs - minimum gap between reports.
 * @param {() => number} [options.now] - clock, injectable for tests.
 * @param {(message: string) => void} options.report - what to do when it is time.
 * @returns {(message: () => string) => boolean} a reporter; true when it reported.
 */
export function createProgressThrottle({ intervalMs, now = () => Date.now(), report }) {
	let last = now()
	/**
	 * @param {() => string} build - builds the message only when it will be sent.
	 * @returns {boolean} whether it reported.
	 */
	return (build) => {
		const at = now()
		if (at - last < intervalMs) return false
		last = at
		report(build())
		return true
	}
}
