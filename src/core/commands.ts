// `/mailbridge` argument routing.
//
// Pure, so the command surface is testable without pi. Keeping the parse separate
// from the handlers is also what lets the same subcommand set back both the in-pi
// command and (where it makes sense) the headless entry point.

export type MailbridgeSubcommand =
	| "on"
	| "off"
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
	/** on/off: apply to every session (the persisted global switch), not just this one. */
	all: boolean
}

/**
 * One table for the command surface: the usage text, the parse whitelist, and the Tab completion
 * all read from it. They were three separate lists, which is how a subcommand ends up documented
 * but unparseable (or the reverse).
 */
export interface SubcommandInfo {
	name: MailbridgeSubcommand
	/** What it does, shown in the help text and next to the completion. */
	hint: string
	/** Extra words after the name in the usage line, when it takes any. */
	args?: string
}

export const SUBCOMMAND_INFO = [
	{ name: "status", hint: "mailbox, queue, last scan, this session" },
	{ name: "on", hint: "email mode on for this session (--all: every session)", args: "[--all]" },
	{ name: "off", hint: "email mode off for this session (--all: every session)", args: "[--all]" },
	{ name: "setup", hint: "write the config and start the daemon", args: "<pi-address> [to <your-…>] [force]" },
	{ name: "check", hint: "validate config, and that credentials are present" },
	{ name: "auth", hint: "approve OAuth2 device login" },
	{ name: "smoke", hint: "send one real mail, then read the folder back" },
	{ name: "prime", hint: "start watching from now, ignoring existing mail" },
	{ name: "restart", hint: "replace the daemon process (picks up new code)" },
	{ name: "help", hint: "this list" },
] as const satisfies readonly SubcommandInfo[]


/**
 * Fails the build if the union and the table disagree in the *other* direction: the `satisfies`
 * above proves table ⊆ union, this proves union ⊆ table. Without it, adding a name to
 * `MailbridgeSubcommand` alone leaves a subcommand that cannot parse, lists or complete.
 */
type MissingFromTable = Exclude<MailbridgeSubcommand, (typeof SUBCOMMAND_INFO)[number]["name"]>
const _everySubcommandIsListed: MissingFromTable extends never ? true : never = true
void _everySubcommandIsListed

/** One line per subcommand, aligned; a long signature (setup) gets two spaces instead. */
function usageLine(command: SubcommandInfo): string {
	const args = (command as { args?: string }).args
	const head = `/mailbridge ${command.name}${args ? ` ${args}` : ""}`
	return `${head.padEnd(34)}${head.length >= 34 ? "  " : ""}${command.hint}`
}

export const USAGE = [
	`/mailbridge${" ".repeat(23)}status (the default)`,
	...SUBCOMMAND_INFO.filter((c) => c.name !== "status").map(usageLine),
].join("\n")

const SUBCOMMANDS: readonly MailbridgeSubcommand[] = SUBCOMMAND_INFO.map((c) => c.name)

export interface ArgCompletion {
	value: string
	label: string
	description?: string
}

/**
 * Tab completion for `/mailbridge <arg>`.
 *
 * Only the first word is completed: after a space the user is typing an argument (an address, a
 * flag), and offering subcommands there would insert `off` after `setup`. `null` means "no
 * suggestions", which is what pi expects when nothing matches.
 */
export function completeSubcommand(prefix: string): ArgCompletion[] | null {
	const typed = prefix.trimStart()
	// `on`/`off` take exactly one flag, and it is the one the user is most likely to half-type.
	//
	// The `value` is the WHOLE argument, not the flag: pi replaces the argument text with it, so
	// returning "--all" for a prefix of "on --" turned a valid command into `/mailbridge --all`, which
	// parses as help. Same reason the single-word completions below return the subcommand itself.
	// A dash is required before anything is offered: Tab at the end of a bare `on` must not propose the
	// machine-wide form, or a habitual Tab would change the scope of the command the user was typing.
	const flag = /^(on|off)\s+(-+\w*)$/i.exec(typed)
	if (flag) {
		const sub = (flag[1] ?? "").toLowerCase()
		const needle = (flag[2] ?? "").toLowerCase()
		// "-a" is a half-typed "--all": normalise any run of leading dashes to exactly two.
		const normalised = needle.startsWith("-") ? `--${needle.replace(/^-+/, "")}` : needle
		const matches = ["--all"].filter((f) => f.startsWith(normalised))
		return matches.length === 0
			? null
			: matches.map((f) => ({ value: `${sub} ${f}`, label: f, description: "every session, not just this one" }))
	}
	if (/\s/.test(typed)) return null
	const needle = typed.toLowerCase()
	const matches = SUBCOMMAND_INFO.filter((c) => c.name.startsWith(needle))
	if (matches.length === 0) return null
	// The hint alone: pi renders a suggestion's description on one line and truncates it without an
	// ellipsis, so appending the argument signature (39 more characters) cut the description off
	// mid-sentence. The signature is in `help`, one Tab away.
	return matches.map((c) => ({ value: c.name, label: c.name, description: c.hint }))
}

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
		return { sub: first ? "help" : "status", force: false, all: false }
	}

	const parsed: ParsedCommand = { sub: first, force: false, all: false }
	if (first === "on" || first === "off") {
		parsed.all = tokens.slice(1).some((t) => t.toLowerCase() === "--all")
		return parsed
	}
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
