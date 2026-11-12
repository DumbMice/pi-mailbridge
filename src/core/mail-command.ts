// Commands arriving as a reply.
//
// Why this exists instead of pi's own dispatcher: `sendUserMessage(..., { expandPromptTemplates:
// true })` hands any text starting with "/" to `_tryExecuteExtensionCommand`, which runs the
// command and returns *without a turn* - and returns `void` to the caller, so a caller cannot
// tell a command that ran from a prompt that pi rejected (no model, expired credentials,
// compaction). This package acks and marks `\Seen` after that call returns, so a silent
// rejection would consume the mail. Dispatching here means we know what happened, and we can
// refuse the commands that must never be triggered by mail.
//
// The parse is deliberately strict: the *entire* body must be one command line. A reply that
// says "please run this" and quotes `/mailbridge off` underneath is a message, not an instruction.

export type SafeSubcommand = "on" | "off" | "status" | "check" | "smoke" | "help"

/** Subcommands a mail reply may run. Everything else stays text for the agent to read. */
export const MAIL_SAFE_SUBCOMMANDS: readonly SafeSubcommand[] = [
	"on",
	"off",
	"status",
	"check",
	"smoke",
	"help",
]

/** Subcommands that change the machine, the credentials or the queue - never by mail. */
export const MAIL_REFUSED_SUBCOMMANDS = ["setup", "auth", "restart", "prime"] as const

export interface MailCommand {
	/** The command name as registered in pi, without the slash. */
	name: "mailbridge"
	/** Text after the command name; for `mailbridge`, the subcommand and its arguments. */
	args: string
	/** Present for `mailbridge`: the subcommand, already checked against the safe list. */
	sub?: SafeSubcommand
}

/**
 * Parse a reply body as a command, or return undefined if it is ordinary text.
 *
 * `\r\n` is normalised because mail bodies carry it. Leading and trailing blank lines are
 * ignored, but any second non-blank line makes this text: a command must be the whole message.
 */
export function parseMailCommand(body: string): MailCommand | undefined {
	const lines = body
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
	if (lines.length !== 1) return undefined

	const line = lines[0]!
	if (!line.startsWith("/")) return undefined
	const space = line.indexOf(" ")
	const name = (space === -1 ? line.slice(1) : line.slice(1, space)).toLowerCase()
	const args = space === -1 ? "" : line.slice(space + 1).trim()

	if (name !== "mailbridge") return undefined

	// Bare `/mailbridge` prints status, exactly as it does at the prompt.
	// Every safe subcommand takes no arguments, so any leftover word means this is a message that
	// happens to start with a command: `/mailbridge off thanks, the deploy is still broken` must
	// reach the agent, not flip the mode and drop the sentence. Splitting on /\s+/ (not "\n")
	// also catches U+2028/U+2029, which a body may contain without a newline.
	const words = args.split(/\s+/).filter(Boolean)
	if (words.length > 1) return undefined
	const sub = (words[0] ?? "").toLowerCase() || "status"
	if (!(MAIL_SAFE_SUBCOMMANDS as readonly string[]).includes(sub)) {
		// `setup`, `auth`, `restart`, `prime` and unknown words stay text, so the agent sees the
		// request and nothing reconfigures itself because someone's address was spoofed.
		return undefined
	}
	return { name, args, sub: sub as SafeSubcommand }
}

/** True when the subcommand changes the machine and must not be triggerable by mail. */
export function isRefusedSubcommand(sub: string): boolean {
	return (MAIL_REFUSED_SUBCOMMANDS as readonly string[]).includes(sub.toLowerCase())
}
