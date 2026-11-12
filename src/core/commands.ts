// `/mailbridge` argument routing.
//
// Pure, so the command surface is testable without pi. Keeping the parse separate
// from the handlers is also what lets the same subcommand set back both the in-pi
// command and (where it makes sense) the headless entry point.

export type MailbridgeSubcommand =
	| "away"
	| "here"
	| "status"
	| "setup"
	| "check"
	| "auth"
	| "smoke"
	| "prime"
	| "restart"
	| "help"

export interface ParsedCommand {
	sub: MailbridgeSubcommand
	/** Setup: the pi address. */
	address?: string
	/** Setup: where the human reads mail. */
	to?: string
	/** Setup: overwrite an existing config. */
	force: boolean
}

export const USAGE = [
	"/mailbridge                 status",
	"/mailbridge away            decisions mail you (away from the terminal)",
	"/mailbridge here            decisions ask in this terminal",
	"/mailbridge setup <pi-address> [to <your-address>] [force]",
	"/mailbridge check           validate config, and that credentials are present",
	"/mailbridge auth            approve OAuth2 device login",
	"/mailbridge smoke           send one real mail, then read the folder back",
	"/mailbridge prime           start watching from now, ignoring existing mail",
	"/mailbridge restart         replace the daemon process (picks up new code, not just config)",
].join("\n")

const SUBCOMMANDS: readonly MailbridgeSubcommand[] = [
	"away",
	"here",
	"status",
	"setup",
	"check",
	"auth",
	"smoke",
	"prime",
	"restart",
	"help",
]

export function isSubcommand(value: string): value is MailbridgeSubcommand {
	return (SUBCOMMANDS as readonly string[]).includes(value)
}

/**
 * Parse the text after `/mailbridge`.
 *
 * Accepts both `--to` and bare `to` because a TUI prompt is not a shell and people
 * type either. Unknown words that are not addresses are ignored rather than
 * treated as errors, so a stray flag cannot silently change the target address.
 */
export function parseMailbridgeCommand(args: string): ParsedCommand {
	const tokens = args.trim().split(/\s+/).filter(Boolean)
	const first = tokens[0]?.toLowerCase()

	if (!first || !isSubcommand(first)) {
		return { sub: first ? "help" : "status", force: false }
	}

	const parsed: ParsedCommand = { sub: first, force: false }
	if (first !== "setup") return parsed

	const rest = tokens.slice(1)
	const addresses: string[] = []
	for (let i = 0; i < rest.length; i++) {
		const token = rest[i]!
		const lower = token.toLowerCase()
		if (lower === "force" || lower === "--force") {
			parsed.force = true
			continue
		}
		if (lower === "to" || lower === "--to") {
			const next = rest[i + 1]
			if (next && !next.startsWith("-") && next.toLowerCase() !== "force") {
				parsed.to = next
				i++
			}
			continue
		}
		if (token.includes("@")) addresses.push(token)
	}

	if (addresses[0]) parsed.address = addresses[0]
	return parsed
}
