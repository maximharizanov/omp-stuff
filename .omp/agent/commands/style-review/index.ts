import * as path from "node:path";

const STYLE_REVIEW_REQUEST_TEMPLATE = `## Style Review Request

### Mode

{{mode}}
{{#if reviewRoot}}

### Review Worktree

\`{{reviewRoot}}\`
{{/if}}

### Changed Files ({{len files}} files, +{{totalAdded}}/-{{totalRemoved}} lines)

{{#if files.length}}
{{#table files headers="File|+/-|Type"}}
{{path}} | +{{linesAdded}}/-{{linesRemoved}} | {{ext}}
{{/table}}
{{else}}
_No files to review._
{{/if}}
{{#if excluded.length}}
### Excluded Files ({{len excluded}})

{{#list excluded prefix="- " join="\n"}}
\`{{path}}\` (+{{linesAdded}}/-{{linesRemoved}}) — {{reason}}
{{/list}}
{{/if}}

### Distribution Guidelines

Use the Task tool with \`agent: "style-guide-reviewer"\`.
{{#when agentCount "==" 1}}Spawn **1 style-guide-reviewer agent**.{{else}}Spawn **{{agentCount}} style-guide-reviewer agents** in parallel.{{/when}}
{{#if multiAgent}}
Group files by locality, e.g.:
- Same directory/module → same agent
- Related functionality → same agent
- Tests with their implementation files → same agent
{{/if}}

### Reviewer Instructions

Each style-guide reviewer **MUST**:
1. Focus ONLY on assigned files
2. {{#if skipDiff}}**MUST** run \`git diff\`/\`git show\`{{#if reviewRoot}} in \`{{reviewRoot}}\`{{/if}} for assigned files{{else}}**MUST** use diff hunks below (**MUST NOT** re-run git diff){{/if}}
3. **MAY** read full file context as needed via \`read\`{{#if reviewRoot}} using absolute paths under \`{{reviewRoot}}\`{{/if}}
4. Review against the embedded style guide in the \`style-guide-reviewer\` agent, not generic bug-finding criteria
5. Call \`report_finding\` per issue
6. Call \`submit_result\` with verdict when done

{{#if skipDiff}}
### Diff Previews

_Full diff too large ({{len files}} files). Showing first ~{{linesPerFile}} lines per file._

{{#list files join="\n\n"}}
#### {{path}}

{{#codeblock lang="diff"}}
{{hunksPreview}}
{{/codeblock}}
{{/list}}
{{else}}

### Diff

<diff>
{{rawDiff}}
</diff>
{{/if}}`;

interface FileDiff {
	path: string;
	linesAdded: number;
	linesRemoved: number;
	hunks: string;
}

interface DiffStats {
	files: FileDiff[];
	totalAdded: number;
	totalRemoved: number;
	excluded: Array<{ path: string; reason: string; linesAdded: number; linesRemoved: number }>;
}

const EXCLUDED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
	{ pattern: /\.lock$/, reason: "lock file" },
	{ pattern: /-lock\.(json|yaml|yml)$/, reason: "lock file" },
	{ pattern: /package-lock\.json$/, reason: "lock file" },
	{ pattern: /yarn\.lock$/, reason: "lock file" },
	{ pattern: /pnpm-lock\.yaml$/, reason: "lock file" },
	{ pattern: /Cargo\.lock$/, reason: "lock file" },
	{ pattern: /Gemfile\.lock$/, reason: "lock file" },
	{ pattern: /poetry\.lock$/, reason: "lock file" },
	{ pattern: /composer\.lock$/, reason: "lock file" },
	{ pattern: /flake\.lock$/, reason: "lock file" },
	{ pattern: /\.min\.(js|css)$/, reason: "minified" },
	{ pattern: /\.generated\./, reason: "generated" },
	{ pattern: /\.snap$/, reason: "snapshot" },
	{ pattern: /\.map$/, reason: "source map" },
	{ pattern: /\.md$/i, reason: "markdown" },
	{ pattern: /^dist\//, reason: "build output" },
	{ pattern: /^build\//, reason: "build output" },
	{ pattern: /^out\//, reason: "build output" },
	{ pattern: /node_modules\//, reason: "vendor" },
	{ pattern: /vendor\//, reason: "vendor" },
	{ pattern: /\.(png|jpg|jpeg|gif|ico|webp|avif)$/i, reason: "image" },
	{ pattern: /\.(woff|woff2|ttf|eot|otf)$/i, reason: "font" },
	{ pattern: /\.(pdf|zip|tar|gz|rar|7z)$/i, reason: "binary" },
];

function getExclusionReason(path: string): string | undefined {
	for (const { pattern, reason } of EXCLUDED_PATTERNS) {
		if (pattern.test(path)) return reason;
	}

	return undefined;
}

function parseDiff(diffOutput: string): DiffStats {
	const files: FileDiff[] = [];
	const excluded: DiffStats["excluded"] = [];
	let totalAdded = 0;
	let totalRemoved = 0;
	const fileChunks = diffOutput.split(/^diff --git /m).filter(Boolean);

	for (const chunk of fileChunks) {
		const headerMatch = chunk.match(/^a\/(.+?) b\/(.+)/);
		if (!headerMatch) continue;

		const path = headerMatch[2];
		let linesAdded = 0;
		let linesRemoved = 0;

		for (const line of chunk.split("\n")) {
			if (line.startsWith("+") && !line.startsWith("+++")) {
				linesAdded++;
			} else if (line.startsWith("-") && !line.startsWith("---")) {
				linesRemoved++;
			}
		}

		const exclusionReason = getExclusionReason(path);
		if (exclusionReason) {
			excluded.push({ path, reason: exclusionReason, linesAdded, linesRemoved });
			continue;
		}

		files.push({
			path,
			linesAdded,
			linesRemoved,
			hunks: `diff --git ${chunk}`,
		});
		totalAdded += linesAdded;
		totalRemoved += linesRemoved;
	}

	return { files, totalAdded, totalRemoved, excluded };
}

function getFileExt(path: string): string {
	const match = path.match(/\.([^.]+)$/);
	return match ? match[1] : "";
}

function getRecommendedAgentCount(stats: DiffStats): number {
	const totalLines = stats.totalAdded + stats.totalRemoved;
	const fileCount = stats.files.length;

	if (totalLines < 100 || fileCount <= 2) return 1;
	if (totalLines < 500) return Math.min(2, fileCount);
	if (totalLines < 2000) return Math.min(4, Math.ceil(fileCount / 3));
	if (totalLines < 5000) return Math.min(8, Math.ceil(fileCount / 2));
	return Math.min(16, fileCount);
}

function getDiffPreview(hunks: string, maxLines: number): string {
	const contentLines: string[] = [];

	for (const line of hunks.split("\n")) {
		if (
			line.startsWith("diff --git") ||
			line.startsWith("index ") ||
			line.startsWith("---") ||
			line.startsWith("+++") ||
			line.startsWith("@@")
		) {
			continue;
		}

		contentLines.push(line);
		if (contentLines.length >= maxLines) break;
	}

	return contentLines.join("\n");
}

const MAX_DIFF_CHARS = 50_000;
const MAX_FILES_FOR_INLINE_DIFF = 20;

interface BuildStyleReviewPromptOptions {
	reviewRoot?: string;
}

function resolveReviewPath(reviewRoot: string | undefined, filePath: string): string {
	return reviewRoot ? path.join(reviewRoot, filePath) : filePath;
}

function buildStyleReviewPrompt(
	api: { pi?: { renderPromptTemplate?: (template: string, context: Record<string, unknown>) => string } },
	mode: string,
	stats: DiffStats,
	rawDiff: string,
	options: BuildStyleReviewPromptOptions = {},
): string {
	const agentCount = getRecommendedAgentCount(stats);
	const skipDiff = rawDiff.length > MAX_DIFF_CHARS || stats.files.length > MAX_FILES_FOR_INLINE_DIFF;
	const linesPerFile = skipDiff ? Math.max(5, Math.floor(100 / stats.files.length)) : 0;
	const filesWithExt = stats.files.map(file => ({
		...file,
		path: resolveReviewPath(options.reviewRoot, file.path),
		ext: getFileExt(file.path),
		hunksPreview: skipDiff ? getDiffPreview(file.hunks, linesPerFile) : "",
	}));
	const excluded = stats.excluded.map(file => ({
		...file,
		path: resolveReviewPath(options.reviewRoot, file.path),
	}));
	const renderPromptTemplate = api.pi?.renderPromptTemplate;

	if (typeof renderPromptTemplate === "function") {
		return renderPromptTemplate(STYLE_REVIEW_REQUEST_TEMPLATE, {
			mode,
			reviewRoot: options.reviewRoot,
			files: filesWithExt,
			excluded,
			totalAdded: stats.totalAdded,
			totalRemoved: stats.totalRemoved,
			agentCount,
			multiAgent: agentCount > 1,
			skipDiff,
			rawDiff: rawDiff.trim(),
			linesPerFile,
		});
	}

	const changedFilesSection = filesWithExt.length === 0
		? "_No files to review._"
		: [
			"File | +/- | Type",
			"--- | --- | ---",
			...filesWithExt.map(file => `${file.path} | +${file.linesAdded}/-${file.linesRemoved} | ${file.ext}`),
		].join("\n");

	const excludedSection = excluded.length === 0
		? ""
		: [
			`### Excluded Files (${excluded.length})`,
			"",
			...excluded.map(file => `- \`${file.path}\` (+${file.linesAdded}/-${file.linesRemoved}) — ${file.reason}`),
		].join("\n");

	const distributionGuidelines = agentCount === 1
		? 'Use the Task tool with `agent: "style-guide-reviewer"`.\nSpawn **1 style-guide-reviewer agent**.'
		: [
			'Use the Task tool with `agent: "style-guide-reviewer"`.',
			`Spawn **${agentCount} style-guide-reviewer agents** in parallel.`,
			"Group files by locality, e.g.:",
			"- Same directory/module → same agent",
			"- Related functionality → same agent",
			"- Tests with their implementation files → same agent",
		].join("\n");

	const reviewerInstructions = [
		"Each style-guide reviewer **MUST**:",
		"1. Focus ONLY on assigned files",
		skipDiff
			? `2. **MUST** run \`git diff\`/\`git show\`${options.reviewRoot ? ` in \`${options.reviewRoot}\`` : ""} for assigned files`
			: "2. **MUST** use diff hunks below (**MUST NOT** re-run git diff)",
		`3. **MAY** read full file context as needed via \`read\`${options.reviewRoot ? ` using absolute paths under \`${options.reviewRoot}\`` : ""}`,
		"4. Review against the embedded style guide in the `style-guide-reviewer` agent, not generic bug-finding criteria",
		"5. Call `report_finding` per issue",
		"6. Call `submit_result` with verdict when done",
	].join("\n");

	const diffSection = skipDiff
		? [
			`### Diff Previews`,
			"",
			`_Full diff too large (${filesWithExt.length} files). Showing first ~${linesPerFile} lines per file._`,
			"",
			...filesWithExt.flatMap(file => [
				`#### ${file.path}`,
				"",
				"```diff",
				file.hunksPreview,
				"```",
				"",
			]),
		].join("\n").trimEnd()
		: [
			"### Diff",
			"",
			"<diff>",
			rawDiff.trim(),
			"</diff>",
		].join("\n");

	return [
		"## Style Review Request",
		"",
		"### Mode",
		"",
		mode,
		...(options.reviewRoot ? ["", "### Review Worktree", "", `\`${options.reviewRoot}\``] : []),
		"",
		`### Changed Files (${filesWithExt.length} files, +${stats.totalAdded}/-${stats.totalRemoved} lines)`,
		"",
		changedFilesSection,
		...(excludedSection ? ["", excludedSection] : []),
		"",
		"### Distribution Guidelines",
		"",
		distributionGuidelines,
		"",
		"### Reviewer Instructions",
		"",
		reviewerInstructions,
		"",
		diffSection,
	].join("\n");
}

const PRIORITIZED_BASE_BRANCHES = ["main", "master", "origin/main", "origin/master"] as const;

function getBaseBranchSortRank(branch: string): number {
	const prioritizedBranchIndex = PRIORITIZED_BASE_BRANCHES.indexOf(
		branch as (typeof PRIORITIZED_BASE_BRANCHES)[number],
	);

	return prioritizedBranchIndex === -1 ? Number.POSITIVE_INFINITY : prioritizedBranchIndex;
}

function sortBaseBranches(branches: string[]): string[] {
	return [...new Set(branches)].sort((leftBranch, rightBranch) => {
		const leftRank = getBaseBranchSortRank(leftBranch);
		const rightRank = getBaseBranchSortRank(rightBranch);

		if (leftRank !== rightRank) return leftRank - rightRank;

		return leftBranch.localeCompare(rightBranch);
	});
}

async function getGitBranches(api: { exec: (command: string, args: string[], options?: Record<string, unknown>) => Promise<{ code: number; stdout: string }> }): Promise<string[]> {
	try {
		const result = await api.exec("git", ["branch", "-a", "--format=%(refname:short)"]);
		if (result.code !== 0) return [];

		const branches = result.stdout.split("\n").map(branch => branch.trim()).filter(Boolean);

		return sortBaseBranches(branches);
	} catch {
		return [];
	}
}

async function getCurrentBranch(api: { exec: (command: string, args: string[]) => Promise<{ stdout: string }> }): Promise<string> {
	try {
		const result = await api.exec("git", ["branch", "--show-current"]);
		return result.stdout.trim() || "HEAD";
	} catch {
		return "HEAD";
	}
}

async function getGitStatus(api: { exec: (command: string, args: string[]) => Promise<{ stdout: string }> }): Promise<string> {
	try {
		const result = await api.exec("git", ["status", "--porcelain"]);
		return result.stdout;
	} catch {
		return "";
	}
}

async function getRecentCommits(api: { exec: (command: string, args: string[]) => Promise<{ code: number; stdout: string }> }, count: number): Promise<string[]> {
	try {
		const result = await api.exec("git", ["log", `-${count}`, "--oneline", "--no-decorate"]);
		if (result.code !== 0) return [];
		return result.stdout.split("\n").map(commit => commit.trim()).filter(Boolean);
	} catch {
		return [];
	}
}

async function getRepoRoot(api: { exec: (command: string, args: string[], options?: Record<string, unknown>) => Promise<{ code: number; stdout: string }> }): Promise<string | undefined> {
	try {
		const result = await api.exec("git", ["rev-parse", "--show-toplevel"], { timeout: 30_000 });
		if (result.code !== 0) return undefined;
		return result.stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

function sanitizeWorktreeSegment(value: string): string {
	const sanitizedValue = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

	return sanitizedValue || "pr";
}

async function getTemporaryPrWorktreePath(repoRoot: string, prRef: string): Promise<string> {
	return path.join(
		path.dirname(repoRoot),
		`${path.basename(repoRoot)}-style-review-${sanitizeWorktreeSegment(prRef)}-${Date.now()}`,
	);
}

async function removeTemporaryWorktree(
	api: { exec: (command: string, args: string[], options?: Record<string, unknown>) => Promise<{ code: number; stdout: string; stderr: string }> },
	worktreePath: string,
): Promise<void> {
	await api.exec("git", ["worktree", "remove", "--force", worktreePath], { timeout: 30000 });
}

async function getPullRequestLabel(
	api: { exec: (command: string, args: string[], options?: Record<string, unknown>) => Promise<{ code: number; stdout: string; stderr: string }> },
	prRef: string,
): Promise<string | undefined> {
	const result = await api.exec("gh", ["pr", "view", prRef, "--json", "number,title"], { timeout: 30000 });
	if (result.code !== 0) return undefined;

	try {
		const pr = JSON.parse(result.stdout) as { number: number; title: string };
		return `#${pr.number} ${pr.title}`;
	} catch {
		return undefined;
	}
}

async function createPrReviewWorktree(
	api: { exec: (command: string, args: string[], options?: Record<string, unknown>) => Promise<{ code: number; stdout: string; stderr: string }> },
	prRef: string,
	worktreePath: string,
): Promise<void> {
	const worktreeResult = await api.exec("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], { timeout: 30000 });
	if (worktreeResult.code !== 0) {
		throw new Error(worktreeResult.stderr || `Failed to create worktree at ${worktreePath}`);
	}

	const checkoutResult = await api.exec("gh", ["pr", "checkout", prRef, "--detach"], {
		cwd: worktreePath,
		timeout: 30000,
	});

	if (checkoutResult.code === 0) return;

	await removeTemporaryWorktree(api, worktreePath);
	throw new Error(checkoutResult.stderr || `Failed to check out PR ${prRef}`);
}

export default function (api: {
	exec: (command: string, args: string[], options?: Record<string, unknown>) => Promise<{ code: number; stdout: string; stderr: string }>;
	pi?: { renderPromptTemplate?: (template: string, context: Record<string, unknown>) => string };
}) {
	return {
		name: "style-review",
		description: "Launch interactive style-guide review",
		async execute(_args: string[], ctx: {
			hasUI: boolean;
			ui: {
				select: (title: string, options: string[]) => Promise<string | undefined>;
				input: (title: string, placeholder?: string) => Promise<string | undefined>;
				notify: (message: string, level: "info" | "warning" | "error") => void;
				editor: (title: string, initialValue?: string) => Promise<string | undefined>;
			};
		}): Promise<string | undefined> {
			if (!ctx.hasUI) {
				return "Use the Task tool with `agent: \"style-guide-reviewer\"` to review recent code changes against the embedded style guide.";
			}

			const mode = await ctx.ui.select("Style Review Mode", [
				"1. Review against a base branch (PR Style)",
				"2. Review uncommitted changes",
				"3. Review a specific commit",
				"4. Review a GitHub PR in a temporary worktree",
				"5. Custom style review instructions",
			]);
			if (!mode) return undefined;

			const modeNum = parseInt(mode[0], 10);

			switch (modeNum) {
				case 1: {
					const branches = await getGitBranches(api);
					if (branches.length === 0) {
						ctx.ui.notify("No git branches found", "error");
						return undefined;
					}

					const baseBranch = await ctx.ui.select("Select base branch to compare against", branches);
					if (!baseBranch) return undefined;

					const currentBranch = await getCurrentBranch(api);
					const diffResult = await api.exec("git", ["diff", `${baseBranch}...${currentBranch}`], { timeout: 30000 });
					if (diffResult.code !== 0) {
						ctx.ui.notify(`Failed to get diff: ${diffResult.stderr}`, "error");
						return undefined;
					}

					if (!diffResult.stdout.trim()) {
						ctx.ui.notify(`No changes between ${baseBranch} and ${currentBranch}`, "warning");
						return undefined;
					}

					const stats = parseDiff(diffResult.stdout);
					if (stats.files.length === 0) {
						ctx.ui.notify("No reviewable files (all changes filtered out)", "warning");
						return undefined;
					}

					return buildStyleReviewPrompt(api, `Reviewing style-guide compliance between \`${baseBranch}\` and \`${currentBranch}\` (PR-style)`, stats, diffResult.stdout);
				}

				case 2: {
					const status = await getGitStatus(api);
					if (!status.trim()) {
						ctx.ui.notify("No uncommitted changes found", "warning");
						return undefined;
					}

					const [unstagedResult, stagedResult] = await Promise.all([
						api.exec("git", ["diff"], { timeout: 30000 }),
						api.exec("git", ["diff", "--cached"], { timeout: 30000 }),
					]);

					const combinedDiff = [unstagedResult.stdout, stagedResult.stdout].filter(Boolean).join("\n");
					if (!combinedDiff.trim()) {
						ctx.ui.notify("No diff content found", "warning");
						return undefined;
					}

					const stats = parseDiff(combinedDiff);
					if (stats.files.length === 0) {
						ctx.ui.notify("No reviewable files (all changes filtered out)", "warning");
						return undefined;
					}

					return buildStyleReviewPrompt(api, "Reviewing style-guide compliance for uncommitted changes (staged + unstaged)", stats, combinedDiff);
				}

				case 3: {
					const commits = await getRecentCommits(api, 20);
					if (commits.length === 0) {
						ctx.ui.notify("No commits found", "error");
						return undefined;
					}

					const selected = await ctx.ui.select("Select commit to review", commits);
					if (!selected) return undefined;

					const hash = selected.split(" ")[0];
					const showResult = await api.exec("git", ["show", "--format=", hash], { timeout: 30000 });
					if (showResult.code !== 0) {
						ctx.ui.notify(`Failed to get commit: ${showResult.stderr}`, "error");
						return undefined;
					}

					if (!showResult.stdout.trim()) {
						ctx.ui.notify("Commit has no diff content", "warning");
						return undefined;
					}

					const stats = parseDiff(showResult.stdout);
					if (stats.files.length === 0) {
						ctx.ui.notify("No reviewable files in commit (all changes filtered out)", "warning");
						return undefined;
					}

					return buildStyleReviewPrompt(api, `Reviewing style-guide compliance for commit \`${hash}\``, stats, showResult.stdout);
				}

				case 4: {
					const prRef = await ctx.ui.input("Enter GitHub PR number or URL", "123 or https://github.com/owner/repo/pull/123");
					if (!prRef?.trim()) return undefined;

					const branches = await getGitBranches(api);
					if (branches.length === 0) {
						ctx.ui.notify("No git branches found", "error");
						return undefined;
					}

					const baseBranch = await ctx.ui.select("Select base branch to compare the PR against", branches);
					if (!baseBranch) return undefined;

					const normalizedPrRef = prRef.trim();
					const repoRoot = await getRepoRoot(api);
					if (!repoRoot) {
						ctx.ui.notify("Failed to determine git repo root", "error");
						return undefined;
					}
					const worktreePath = await getTemporaryPrWorktreePath(repoRoot, normalizedPrRef);
					const prLabel = await getPullRequestLabel(api, normalizedPrRef);

					try {
						await createPrReviewWorktree(api, normalizedPrRef, worktreePath);
					} catch (error) {
						ctx.ui.notify(
							`Failed to prepare PR worktree: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
						return undefined;
					}

					const diffResult = await api.exec("git", ["diff", `${baseBranch}...HEAD`], {
						cwd: worktreePath,
						timeout: 30000,
					});
					if (diffResult.code !== 0) {
						ctx.ui.notify(`Failed to get PR diff: ${diffResult.stderr}`, "error");
						return undefined;
					}

					if (!diffResult.stdout.trim()) {
						ctx.ui.notify(`No changes between ${normalizedPrRef} and ${baseBranch}`, "warning");
						return undefined;
					}

					const stats = parseDiff(diffResult.stdout);
					if (stats.files.length === 0) {
						ctx.ui.notify("No reviewable files in PR (all changes filtered out)", "warning");
						return undefined;
					}

					return buildStyleReviewPrompt(
						api,
						`Reviewing style-guide compliance for GitHub PR ${prLabel ?? normalizedPrRef} against \`${baseBranch}\` in temporary worktree \`${worktreePath}\``,
						stats,
						diffResult.stdout,
						{ reviewRoot: worktreePath },
					);
				}

				case 5: {
					const instructions = await ctx.ui.editor("Enter custom style-review instructions", "Review the following patch against the style guide:\n\n");
					if (!instructions?.trim()) return undefined;

					const diffResult = await api.exec("git", ["diff", "HEAD"], { timeout: 30000 });
					const hasDiff = diffResult.code === 0 && diffResult.stdout.trim();
					if (hasDiff) {
						const stats = parseDiff(diffResult.stdout);
						return `${buildStyleReviewPrompt(api, `Custom style review: ${instructions.split("\n")[0].slice(0, 60)}…`, stats, diffResult.stdout)}\n\n### Additional Instructions\n\n${instructions}`;
					}

					return `## Style Review Request\n\n### Mode\nCustom style review instructions\n\n### Instructions\n\n${instructions}\n\nUse the Task tool with \`agent: "style-guide-reviewer"\` to execute this review.`;
				}

				default:
					return undefined;
			}
		},
	};
}
