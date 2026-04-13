import { promises as fs } from "node:fs";
import * as path from "node:path";

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

interface TaskSummary {
	total: number;
	completed: number;
	incomplete: number;
}

interface OpenSpecChangeSummary {
	name: string;
	completedTasks?: number;
	totalTasks?: number;
	lastModified?: string;
	status?: string;
}

interface OpenSpecListResponse {
	changes: OpenSpecChangeSummary[];
}

interface OpenSpecStatusArtifact {
	id: string;
	outputPath: string;
	status: string;
}

interface OpenSpecStatusResponse {
	changeName: string;
	schemaName?: string;
	isComplete?: boolean;
	applyRequires?: string[];
	artifacts?: OpenSpecStatusArtifact[];
}

interface OpenSpecInstructionTask {
	id: string;
	description: string;
	done: boolean;
}

interface OpenSpecApplyInstructionsResponse {
	changeName: string;
	changeDir: string;
	schemaName?: string;
	contextFiles?: Record<string, string>;
	progress?: {
		total: number;
		complete: number;
		remaining: number;
	};
	tasks?: OpenSpecInstructionTask[];
	state?: string;
	instruction?: string;
}

interface OpenSpecArtifacts {
	repoRoot: string;
	changeRoot: string;
	changeName: string;
	schemaName?: string;
	state?: string;
	instruction?: string;
	deltaSpecPath: string;
	deltaSpecRelativePath: string;
	capabilityRelativePath: string;
	deltaSpecContent: string;
	currentSpecPath?: string;
	currentSpecContent?: string;
	proposalPath?: string;
	proposalContent?: string;
	designPath?: string;
	designContent?: string;
	tasksPath?: string;
	tasksContent?: string;
	requirementTitles: string[];
	scenarioTitles: string[];
	taskSummary: TaskSummary;
}

type VerificationMode = "baseBranch" | "uncommitted" | "commit" | "pullRequest" | "custom";

type ExecApi = {
	exec: (command: string, args: string[], options?: Record<string, unknown>) => Promise<{ code: number; stdout: string; stderr: string }>;
};

interface SelectUi {
	select: (title: string, options: string[]) => Promise<string | undefined>;
	input: (title: string, placeholder?: string) => Promise<string | undefined>;
	notify: (message: string, level: "info" | "warning" | "error") => void;
	editor: (title: string, initialValue?: string) => Promise<string | undefined>;
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
	{ pattern: /^dist\//, reason: "build output" },
	{ pattern: /^build\//, reason: "build output" },
	{ pattern: /^out\//, reason: "build output" },
	{ pattern: /node_modules\//, reason: "vendor" },
	{ pattern: /vendor\//, reason: "vendor" },
	{ pattern: /\.(png|jpg|jpeg|gif|ico|webp|avif)$/i, reason: "image" },
	{ pattern: /\.(woff|woff2|ttf|eot|otf)$/i, reason: "font" },
	{ pattern: /\.(pdf|zip|tar|gz|rar|7z)$/i, reason: "binary" },
];

const PRIORITIZED_BASE_BRANCHES = ["main", "master", "origin/main", "origin/master"] as const;
const MAX_DIFF_CHARS = 50_000;
const MAX_FILES_FOR_INLINE_DIFF = 20;
const EMPTY_DIFF_STATS: DiffStats = { files: [], totalAdded: 0, totalRemoved: 0, excluded: [] };
const MODE_OPTIONS: Record<VerificationMode, string> = {
	baseBranch: "1. Verify against a base branch (PR Style)",
	uncommitted: "2. Verify uncommitted changes",
	commit: "3. Verify a specific commit",
	pullRequest: "4. Verify a GitHub PR in a temporary worktree",
	custom: "5. Custom OpenSpec verification instructions",
};

function normalizeRepoRelativePath(filePath: string): string {
	return filePath.split(path.sep).join("/");
}

function assertUnreachable(value: never): never {
	throw new Error(`Unexpected value: ${String(value)}`);
}

function getExclusionReason(filePath: string): string | undefined {
	for (const { pattern, reason } of EXCLUDED_PATTERNS) {
		if (pattern.test(filePath)) return reason;
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

		const filePath = headerMatch[2];
		let linesAdded = 0;
		let linesRemoved = 0;

		for (const line of chunk.split("\n")) {
			if (line.startsWith("+") && !line.startsWith("+++")) {
				linesAdded++;
			} else if (line.startsWith("-") && !line.startsWith("---")) {
				linesRemoved++;
			}
		}

		const exclusionReason = getExclusionReason(filePath);
		if (exclusionReason) {
			excluded.push({ path: filePath, reason: exclusionReason, linesAdded, linesRemoved });
			continue;
		}

		files.push({
			path: filePath,
			linesAdded,
			linesRemoved,
			hunks: `diff --git ${chunk}`,
		});
		totalAdded += linesAdded;
		totalRemoved += linesRemoved;
	}

	return { files, totalAdded, totalRemoved, excluded };
}

function getFileExt(filePath: string): string {
	const match = filePath.match(/\.([^.]+)$/);
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

function resolveReviewPath(reviewRoot: string | undefined, filePath: string): string {
	return reviewRoot ? path.join(reviewRoot, filePath) : filePath;
}

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

function parseVerificationMode(selection: string): VerificationMode {
	switch (selection) {
		case MODE_OPTIONS.baseBranch:
			return "baseBranch";
		case MODE_OPTIONS.uncommitted:
			return "uncommitted";
		case MODE_OPTIONS.commit:
			return "commit";
		case MODE_OPTIONS.pullRequest:
			return "pullRequest";
		case MODE_OPTIONS.custom:
			return "custom";
		default:
			throw new Error(`Unexpected verification mode: ${selection}`);
	}
}

function parseJsonPayload<T>(stdout: string): T {
	const objectStart = stdout.indexOf("{");
	const arrayStart = stdout.indexOf("[");
		const startCandidates = [objectStart, arrayStart].filter(index => index >= 0);
	if (startCandidates.length === 0) {
		throw new Error(`Expected JSON in command output, got: ${stdout.slice(0, 200)}`);
	}

	const startIndex = Math.min(...startCandidates);
	const lastObjectEnd = stdout.lastIndexOf("}");
	const lastArrayEnd = stdout.lastIndexOf("]");
	const endIndex = Math.max(lastObjectEnd, lastArrayEnd);
	if (endIndex < startIndex) {
		throw new Error(`Could not locate complete JSON payload in command output: ${stdout.slice(0, 200)}`);
	}

	return JSON.parse(stdout.slice(startIndex, endIndex + 1)) as T;
}

function summarizeTasksFromInstructions(instructions: OpenSpecApplyInstructionsResponse, tasksContent: string | undefined): TaskSummary {
	if (instructions.progress) {
		const completed = instructions.progress.complete ?? 0;
		const total = instructions.progress.total ?? completed;
		return { total, completed, incomplete: Math.max(0, total - completed) };
	}

	if (instructions.tasks?.length) {
		const completed = instructions.tasks.filter(task => task.done).length;
		const total = instructions.tasks.length;
		return { total, completed, incomplete: total - completed };
	}

	if (!tasksContent) return { total: 0, completed: 0, incomplete: 0 };
	const completed = (tasksContent.match(/^- \[x\]/gim) ?? []).length;
	const incomplete = (tasksContent.match(/^- \[ \]/gim) ?? []).length;
	return { total: completed + incomplete, completed, incomplete };
}

function getTouchedChangeNames(changedFiles: string[]): Set<string> {
	const touchedChangeNames = new Set<string>();
	for (const changedFile of changedFiles) {
		const match = changedFile.match(/^openspec\/changes\/([^/]+)\//);
		if (match?.[1] && match[1] !== "archive") {
			touchedChangeNames.add(match[1]);
		}
	}
	return touchedChangeNames;
}

function buildChangeOption(change: OpenSpecChangeSummary, touchedChangeNames: Set<string>): string {
	const progress = typeof change.completedTasks === "number" && typeof change.totalTasks === "number"
		? `${change.completedTasks}/${change.totalTasks} tasks`
		: "tasks unknown";
	const status = change.status ?? "unknown";
	const touched = touchedChangeNames.has(change.name) ? " — touched in diff" : "";
	return `${change.name} — ${status} — ${progress}${touched}`;
}

async function getGitBranches(api: ExecApi): Promise<string[]> {
	try {
		const result = await api.exec("git", ["branch", "-a", "--format=%(refname:short)"]);
		if (result.code !== 0) return [];

		const branches = result.stdout.split("\n").map(branch => branch.trim()).filter(Boolean);
		return sortBaseBranches(branches);
	} catch {
		return [];
	}
}

async function getCurrentBranch(api: ExecApi): Promise<string> {
	try {
		const result = await api.exec("git", ["branch", "--show-current"]);
		return result.stdout.trim() || "HEAD";
	} catch {
		return "HEAD";
	}
}

async function getGitStatus(api: ExecApi): Promise<string> {
	try {
		const result = await api.exec("git", ["status", "--porcelain"]);
		return result.stdout;
	} catch {
		return "";
	}
}

async function getRecentCommits(api: ExecApi, count: number): Promise<string[]> {
	try {
		const result = await api.exec("git", ["log", `-${count}`, "--oneline", "--no-decorate"]);
		if (result.code !== 0) return [];
		return result.stdout.split("\n").map(commit => commit.trim()).filter(Boolean);
	} catch {
		return [];
	}
}

function sanitizeWorktreeSegment(value: string): string {
	const sanitizedValue = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
	return sanitizedValue || "pr";
}

async function getTemporaryPrWorktreePath(repoRoot: string, prRef: string): Promise<string> {
	return path.join(
		path.dirname(repoRoot),
		`${path.basename(repoRoot)}-openspec-verify-${sanitizeWorktreeSegment(prRef)}-${Date.now()}`,
	);
}

async function removeTemporaryWorktree(api: ExecApi, worktreePath: string): Promise<void> {
	await api.exec("git", ["worktree", "remove", "--force", worktreePath], { timeout: 30000 });
}

async function getPullRequestLabel(api: ExecApi, prRef: string): Promise<string | undefined> {
	const result = await api.exec("gh", ["pr", "view", prRef, "--json", "number,title"], { timeout: 30000 });
	if (result.code !== 0) return undefined;

	try {
		const pr = JSON.parse(result.stdout) as { number: number; title: string };
		return `#${pr.number} ${pr.title}`;
	} catch {
		return undefined;
	}
}

async function createPrReviewWorktree(api: ExecApi, prRef: string, worktreePath: string): Promise<void> {
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

async function getRepoRoot(api: ExecApi, cwd?: string): Promise<string | undefined> {
	const result = await api.exec("git", ["rev-parse", "--show-toplevel"], cwd ? { cwd, timeout: 30000 } : { timeout: 30000 });
	if (result.code !== 0) return undefined;
	const repoRoot = result.stdout.trim();
	return repoRoot || undefined;
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await fs.access(targetPath);
		return true;
	} catch {
		return false;
	}
}

async function readOptionalText(targetPath: string | undefined): Promise<string | undefined> {
	if (!targetPath) return undefined;
	if (!(await pathExists(targetPath))) return undefined;
	return fs.readFile(targetPath, "utf8");
}

async function listMarkdownFilesRecursively(directoryPath: string): Promise<string[]> {
	if (!(await pathExists(directoryPath))) return [];

	const markdownFiles: string[] = [];

	async function walk(currentDirectoryPath: string): Promise<void> {
		const entries = await fs.readdir(currentDirectoryPath, { withFileTypes: true });
		for (const entry of entries) {
			const entryPath = path.join(currentDirectoryPath, entry.name);
			if (entry.isDirectory()) {
				await walk(entryPath);
				continue;
			}
			if (entry.name.endsWith(".md")) markdownFiles.push(entryPath);
		}
	}

	await walk(directoryPath);
	return markdownFiles.sort((leftPath, rightPath) => leftPath.localeCompare(rightPath));
}

async function runOpenSpecList(api: ExecApi, cwd: string): Promise<OpenSpecChangeSummary[]> {
	const result = await api.exec("openspec", ["list", "--json"], { cwd, timeout: 30000 });
	if (result.code !== 0) {
		throw new Error(result.stderr || "openspec list failed");
	}

	const parsed = parseJsonPayload<OpenSpecListResponse>(result.stdout);
	return parsed.changes ?? [];
}

async function runOpenSpecStatus(api: ExecApi, changeName: string, cwd: string): Promise<OpenSpecStatusResponse> {
	const result = await api.exec("openspec", ["status", "--change", changeName, "--json"], { cwd, timeout: 30000 });
	if (result.code !== 0) {
		throw new Error(result.stderr || `openspec status failed for ${changeName}`);
	}

	return parseJsonPayload<OpenSpecStatusResponse>(result.stdout);
}

async function runOpenSpecInstructionsApply(api: ExecApi, changeName: string, cwd: string): Promise<OpenSpecApplyInstructionsResponse> {
	const result = await api.exec("openspec", ["instructions", "apply", "--change", changeName, "--json"], {
		cwd,
		timeout: 30000,
	});
	if (result.code !== 0) {
		throw new Error(result.stderr || `openspec instructions apply failed for ${changeName}`);
	}

	return parseJsonPayload<OpenSpecApplyInstructionsResponse>(result.stdout);
}

async function selectOpenSpecChange(
	api: ExecApi,
	repoRoot: string,
	changedFiles: string[],
	ui: SelectUi,
): Promise<OpenSpecChangeSummary | undefined> {
	const changes = await runOpenSpecList(api, repoRoot);
	if (changes.length === 0) {
		ui.notify("No active OpenSpec changes found", "error");
		return undefined;
	}

	const touchedChangeNames = getTouchedChangeNames(changedFiles);
	const rankedChanges = [...changes].sort((leftChange, rightChange) => {
		const leftTouched = touchedChangeNames.has(leftChange.name) ? 0 : 1;
		const rightTouched = touchedChangeNames.has(rightChange.name) ? 0 : 1;
		if (leftTouched !== rightTouched) return leftTouched - rightTouched;
		return leftChange.name.localeCompare(rightChange.name);
	});

	if (rankedChanges.length === 1) return rankedChanges[0];

	const options = rankedChanges.map(change => buildChangeOption(change, touchedChangeNames));
	const selected = await ui.select("Select OpenSpec change to verify against", options);
	if (!selected) return undefined;
	return rankedChanges[options.indexOf(selected)];
}

async function selectDeltaSpecForChange(
	instructions: OpenSpecApplyInstructionsResponse,
	repoRoot: string,
	changedFiles: string[],
	ui: SelectUi,
): Promise<string | undefined> {
	const changeSpecsRoot = path.join(instructions.changeDir, "specs");
	const candidateSpecs = await listMarkdownFilesRecursively(changeSpecsRoot);
	if (candidateSpecs.length === 0) {
		ui.notify(`No OpenSpec delta specs found under ${changeSpecsRoot}`, "error");
		return undefined;
	}

	const rankedSpecs = [...candidateSpecs].sort((leftSpecPath, rightSpecPath) => {
		const leftRelativePath = normalizeRepoRelativePath(path.relative(repoRoot, leftSpecPath));
		const rightRelativePath = normalizeRepoRelativePath(path.relative(repoRoot, rightSpecPath));
		const leftTouched = changedFiles.includes(leftRelativePath) ? 0 : 1;
		const rightTouched = changedFiles.includes(rightRelativePath) ? 0 : 1;
		if (leftTouched !== rightTouched) return leftTouched - rightTouched;
		return leftRelativePath.localeCompare(rightRelativePath);
	});

	if (rankedSpecs.length === 1) return rankedSpecs[0];

	const options = rankedSpecs.map(specPath => {
		const relativePath = normalizeRepoRelativePath(path.relative(repoRoot, specPath));
		return changedFiles.includes(relativePath) ? `${relativePath} — changed in diff` : relativePath;
	});
	const selected = await ui.select("Select OpenSpec delta spec to verify against", options);
	if (!selected) return undefined;
	return rankedSpecs[options.indexOf(selected)];
}

function extractMatches(content: string, pattern: RegExp): string[] {
	const values: string[] = [];
	for (const match of content.matchAll(pattern)) {
		if (match[1]) values.push(match[1].trim());
	}
	return values;
}

async function loadOpenSpecArtifacts(
	repoRoot: string,
	status: OpenSpecStatusResponse,
	instructions: OpenSpecApplyInstructionsResponse,
	deltaSpecPath: string,
): Promise<OpenSpecArtifacts> {
	const normalizedDeltaSpecPath = path.resolve(deltaSpecPath);
	const deltaSpecRelativePath = normalizeRepoRelativePath(path.relative(repoRoot, normalizedDeltaSpecPath));
	const changeRoot = instructions.changeDir;
	const capabilityRelativePath = normalizeRepoRelativePath(path.relative(path.join(changeRoot, "specs"), normalizedDeltaSpecPath));
	const currentSpecPath = path.join(repoRoot, "openspec", "specs", capabilityRelativePath);
	const proposalPath = instructions.contextFiles?.proposal;
	const designPath = instructions.contextFiles?.design;
	const tasksPath = instructions.contextFiles?.tasks;
	const deltaSpecContent = await fs.readFile(normalizedDeltaSpecPath, "utf8");
	const currentSpecContent = await readOptionalText(currentSpecPath);
	const proposalContent = await readOptionalText(proposalPath);
	const designContent = await readOptionalText(designPath);
	const tasksContent = await readOptionalText(tasksPath);

	return {
		repoRoot,
		changeRoot,
		changeName: instructions.changeName,
		schemaName: instructions.schemaName ?? status.schemaName,
		state: instructions.state,
		instruction: instructions.instruction,
		deltaSpecPath: normalizedDeltaSpecPath,
		deltaSpecRelativePath,
		capabilityRelativePath,
		deltaSpecContent,
		currentSpecPath: currentSpecContent ? currentSpecPath : undefined,
		currentSpecContent,
		proposalPath: proposalContent ? proposalPath : undefined,
		proposalContent,
		designPath: designContent ? designPath : undefined,
		designContent,
		tasksPath: tasksContent ? tasksPath : undefined,
		tasksContent,
		requirementTitles: extractMatches(deltaSpecContent, /^### Requirement:\s+(.+)$/gm),
		scenarioTitles: extractMatches(deltaSpecContent, /^#### Scenario:\s+(.+)$/gm),
		taskSummary: summarizeTasksFromInstructions(instructions, tasksContent),
	};
}

function formatOptionalArtifactPath(label: string, artifactPath: string | undefined): string {
	return artifactPath ? `- ${label}: \`${artifactPath}\`` : `- ${label}: _not found_`;
}

function buildArtifactBlock(tag: string, artifactPath: string, content: string): string {
	return [`<${tag} path="${artifactPath}">`, content.trim(), `</${tag}>`].join("\n");
}

function buildOpenSpecArtifactsSection(artifacts: OpenSpecArtifacts): string {
	const blocks = [buildArtifactBlock("delta-spec", artifacts.deltaSpecPath, artifacts.deltaSpecContent)];
	if (artifacts.currentSpecPath && artifacts.currentSpecContent) {
		blocks.push(buildArtifactBlock("current-spec", artifacts.currentSpecPath, artifacts.currentSpecContent));
	}
	if (artifacts.proposalPath && artifacts.proposalContent) {
		blocks.push(buildArtifactBlock("proposal", artifacts.proposalPath, artifacts.proposalContent));
	}
	if (artifacts.designPath && artifacts.designContent) {
		blocks.push(buildArtifactBlock("design", artifacts.designPath, artifacts.designContent));
	}
	if (artifacts.tasksPath && artifacts.tasksContent) {
		blocks.push(buildArtifactBlock("tasks", artifacts.tasksPath, artifacts.tasksContent));
	}

	return [`<openspec-artifacts>`, ...blocks, `</openspec-artifacts>`].join("\n\n");
}

function buildChangedFilesSection(files: Array<FileDiff & { ext: string }>): string {
	if (files.length === 0) return "_No files to review._";
	return [
		"File | +/- | Type",
		"--- | --- | ---",
		...files.map(file => `${file.path} | +${file.linesAdded}/-${file.linesRemoved} | ${file.ext}`),
	].join("\n");
}

function buildExcludedSection(excluded: DiffStats["excluded"]): string {
	if (excluded.length === 0) return "";
	return [
		`### Excluded Files (${excluded.length})`,
		"",
		...excluded.map(file => `- \`${file.path}\` (+${file.linesAdded}/-${file.linesRemoved}) — ${file.reason}`),
	].join("\n");
}

function buildDistributionGuidelines(agentCount: number, artifacts: OpenSpecArtifacts): string {
	if (agentCount === 1) {
		return 'Use the Task tool with `agent: "openspec-verifier"`.\nSpawn **1 openspec-verifier agent**.';
	}

	const requirementLines = artifacts.requirementTitles.length === 0
		? ["- If requirement headings are unavailable, split by the smallest coherent spec concern."]
		: artifacts.requirementTitles.map(title => `- ${title}`);

	return [
		'Use the Task tool with `agent: "openspec-verifier"`.',
		`Spawn **${agentCount} openspec-verifier agents** in parallel.`,
		"Group work by OpenSpec requirement/scenario locality, not file locality:",
		"- One requirement (or tightly coupled scenario cluster) per agent when possible",
		"- Keep all touched implementation files and tests for that requirement in the same agent",
		"- Only split a requirement across agents when the patch is too large for one focused review",
		"",
		"Suggested requirement split axes:",
		...requirementLines,
	].join("\n");
}

function buildReviewerInstructions(skipDiff: boolean, reviewRoot?: string): string {
	return [
		"Each OpenSpec verifier **MUST**:",
		"1. Focus ONLY on the assigned requirement/scenario cluster and the files needed to evaluate it",
		skipDiff
			? `2. **MUST** run \`git diff\`/\`git show\`${reviewRoot ? ` in \`${reviewRoot}\`` : ""} for the assigned scope`
			: "2. **MUST** use diff hunks below (**MUST NOT** re-run git diff when a `<diff>` block is provided)",
		"3. Treat `<delta-spec>` as the primary contract; use `<current-spec>`, `<proposal>`, `<design>`, and `<tasks>` only as supporting context",
		"4. Cite the exact artifact section in every finding body",
		`5. **MAY** read full file context as needed via \`read\`${reviewRoot ? ` using absolute paths under \`${reviewRoot}\`` : ""}`,
		"6. Call `report_finding` per issue",
		"7. Call `submit_result` with verdict when done",
	].join("\n");
}

function buildTasksSummary(artifacts: OpenSpecArtifacts): string {
	if (artifacts.taskSummary.total === 0) return "_No tasks.md found._";
	return `${artifacts.taskSummary.completed}/${artifacts.taskSummary.total} completed, ${artifacts.taskSummary.incomplete} incomplete`;

}

function buildDiffSection(
	files: Array<FileDiff & { ext: string; hunksPreview: string }>,
	rawDiff: string,
	skipDiff: boolean,
	linesPerFile: number,
): string {
	if (!rawDiff.trim()) return ["### Diff", "", "_No diff provided._"].join("\n");
	if (!skipDiff) return ["### Diff", "", "<diff>", rawDiff.trim(), "</diff>"].join("\n");

	return [
		"### Diff Previews",
		"",
		`_Full diff too large (${files.length} files). Showing first ~${linesPerFile} lines per file._`,
		"",
		...files.flatMap(file => [`#### ${file.path}`, "", "```diff", file.hunksPreview, "```", ""]),
	].join("\n").trimEnd();
}

interface BuildOpenSpecPromptOptions {
	reviewRoot?: string;
	additionalInstructions?: string;
}

function buildOpenSpecVerifyPrompt(
	mode: string,
	stats: DiffStats,
	rawDiff: string,
	artifacts: OpenSpecArtifacts,
	options: BuildOpenSpecPromptOptions = {},
): string {
	const agentCount = getRecommendedAgentCount(stats);
	const skipDiff = rawDiff.length > MAX_DIFF_CHARS || stats.files.length > MAX_FILES_FOR_INLINE_DIFF;
	const linesPerFile = skipDiff && stats.files.length > 0 ? Math.max(5, Math.floor(100 / stats.files.length)) : 0;
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

	return [
		"## OpenSpec Verification Request",
		"",
		"### Mode",
		"",
		mode,
		...(options.reviewRoot ? ["", "### Review Worktree", "", `\`${options.reviewRoot}\``] : []),
		"",
		"### Target OpenSpec Delta Spec",
		"",
		`- Change: \`${artifacts.changeName}\``,
		`- Schema: \`${artifacts.schemaName ?? "unknown"}\``,
		`- Delta spec: \`${artifacts.deltaSpecPath}\``,
		`- Capability path: \`${artifacts.capabilityRelativePath}\``,
		`- Tasks: ${buildTasksSummary(artifacts)}`,
		formatOptionalArtifactPath("Current spec", artifacts.currentSpecPath),
		formatOptionalArtifactPath("Proposal", artifacts.proposalPath),
		formatOptionalArtifactPath("Design", artifacts.designPath),
		formatOptionalArtifactPath("Tasks", artifacts.tasksPath),
		"",
		`### Changed Files (${filesWithExt.length} files, +${stats.totalAdded}/-${stats.totalRemoved} lines)`,
		"",
		buildChangedFilesSection(filesWithExt),
		...(excluded.length > 0 ? ["", buildExcludedSection(excluded)] : []),
		"",
		"### Distribution Guidelines",
		"",
		buildDistributionGuidelines(agentCount, artifacts),
		"",
		"### Reviewer Instructions",
		"",
		buildReviewerInstructions(skipDiff, options.reviewRoot),
		"",
		"### OpenSpec Artifacts",
		"",
		buildOpenSpecArtifactsSection(artifacts),
		"",
		buildDiffSection(filesWithExt, rawDiff, skipDiff, linesPerFile),
		...(options.additionalInstructions ? ["", "### Additional Instructions", "", options.additionalInstructions.trim()] : []),
	].join("\n");
}

async function resolveArtifactsForDiff(
	api: ExecApi,
	repoRoot: string,
	diffOutput: string,
	ui: SelectUi,
): Promise<{ stats: DiffStats; artifacts: OpenSpecArtifacts } | undefined> {
	const stats = parseDiff(diffOutput);
	if (stats.files.length === 0) {
		ui.notify("No reviewable files (all changes filtered out)", "warning");
		return undefined;
	}

	const changedFiles = stats.files.map(file => file.path);
	const selectedChange = await selectOpenSpecChange(api, repoRoot, changedFiles, ui);
	if (!selectedChange) return undefined;

	let status: OpenSpecStatusResponse;
	let instructions: OpenSpecApplyInstructionsResponse;
	try {
		[status, instructions] = await Promise.all([
			runOpenSpecStatus(api, selectedChange.name, repoRoot),
			runOpenSpecInstructionsApply(api, selectedChange.name, repoRoot),
		]);
	} catch (error) {
		ui.notify(error instanceof Error ? error.message : String(error), "error");
		return undefined;
	}

	const deltaSpecPath = await selectDeltaSpecForChange(instructions, repoRoot, changedFiles, ui);
	if (!deltaSpecPath) return undefined;
	const artifacts = await loadOpenSpecArtifacts(repoRoot, status, instructions, deltaSpecPath);
	return { stats, artifacts };
}

export default function (api: ExecApi) {
	return {
		name: "openspec-verify",
		description: "Launch interactive OpenSpec verification against a delta spec",
		async execute(_args: string[], ctx: { hasUI: boolean; ui: SelectUi }): Promise<string | undefined> {
			if (!ctx.hasUI) {
				return "Use the Task tool with `agent: \"openspec-verifier\"` to verify recent code changes against a selected OpenSpec delta spec.";
			}

			const selectedMode = await ctx.ui.select("OpenSpec Verification Mode", Object.values(MODE_OPTIONS));
			if (!selectedMode) return undefined;

			const verificationMode = parseVerificationMode(selectedMode);

			switch (verificationMode) {
				case "baseBranch": {
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

					const repoRoot = await getRepoRoot(api);
					if (!repoRoot) {
						ctx.ui.notify("Failed to determine git repo root", "error");
						return undefined;
					}

					const resolvedArtifacts = await resolveArtifactsForDiff(api, repoRoot, diffResult.stdout, ctx.ui);
					if (!resolvedArtifacts) return undefined;

					return buildOpenSpecVerifyPrompt(
						`Verifying changes between \`${baseBranch}\` and \`${currentBranch}\` against OpenSpec delta spec \`${resolvedArtifacts.artifacts.deltaSpecRelativePath}\``,
						resolvedArtifacts.stats,
						diffResult.stdout,
						resolvedArtifacts.artifacts,
					);
				}

				case "uncommitted": {
					const status = await getGitStatus(api);
					if (!status.trim()) {
						ctx.ui.notify("No uncommitted changes found", "warning");
						return undefined;
					}

					const diffResult = await api.exec("git", ["diff", "HEAD"], { timeout: 30000 });
					if (diffResult.code !== 0) {
						ctx.ui.notify(`Failed to get diff: ${diffResult.stderr}`, "error");
						return undefined;
					}
					if (!diffResult.stdout.trim()) {
						ctx.ui.notify("No diff content found", "warning");
						return undefined;
					}

					const repoRoot = await getRepoRoot(api);
					if (!repoRoot) {
						ctx.ui.notify("Failed to determine git repo root", "error");
						return undefined;
					}

					const resolvedArtifacts = await resolveArtifactsForDiff(api, repoRoot, diffResult.stdout, ctx.ui);
					if (!resolvedArtifacts) return undefined;

					return buildOpenSpecVerifyPrompt(
						`Verifying uncommitted changes (staged + unstaged) against OpenSpec delta spec \`${resolvedArtifacts.artifacts.deltaSpecRelativePath}\``,
						resolvedArtifacts.stats,
						diffResult.stdout,
						resolvedArtifacts.artifacts,
					);
				}

				case "commit": {
					const commits = await getRecentCommits(api, 20);
					if (commits.length === 0) {
						ctx.ui.notify("No commits found", "error");
						return undefined;
					}

					const selectedCommit = await ctx.ui.select("Select commit to verify", commits);
					if (!selectedCommit) return undefined;

					const hash = selectedCommit.split(" ")[0];
					const showResult = await api.exec("git", ["show", "--format=", hash], { timeout: 30000 });
					if (showResult.code !== 0) {
						ctx.ui.notify(`Failed to get commit: ${showResult.stderr}`, "error");
						return undefined;
					}
					if (!showResult.stdout.trim()) {
						ctx.ui.notify("Commit has no diff content", "warning");
						return undefined;
					}

					const repoRoot = await getRepoRoot(api);
					if (!repoRoot) {
						ctx.ui.notify("Failed to determine git repo root", "error");
						return undefined;
					}

					const resolvedArtifacts = await resolveArtifactsForDiff(api, repoRoot, showResult.stdout, ctx.ui);
					if (!resolvedArtifacts) return undefined;

					return buildOpenSpecVerifyPrompt(
						`Verifying commit \`${hash}\` against OpenSpec delta spec \`${resolvedArtifacts.artifacts.deltaSpecRelativePath}\``,
						resolvedArtifacts.stats,
						showResult.stdout,
						resolvedArtifacts.artifacts,
					);
				}

				case "pullRequest": {
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
					const sourceRepoRoot = await getRepoRoot(api);
					if (!sourceRepoRoot) {
						ctx.ui.notify("Failed to determine git repo root", "error");
						return undefined;
					}
					const worktreePath = await getTemporaryPrWorktreePath(sourceRepoRoot, normalizedPrRef);
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

					const worktreeRepoRoot = await getRepoRoot(api, worktreePath);
					if (!worktreeRepoRoot) {
						ctx.ui.notify("Failed to determine PR worktree repo root", "error");
						return undefined;
					}

					const resolvedArtifacts = await resolveArtifactsForDiff(api, worktreeRepoRoot, diffResult.stdout, ctx.ui);
					if (!resolvedArtifacts) return undefined;

					return buildOpenSpecVerifyPrompt(
						`Verifying GitHub PR ${prLabel ?? normalizedPrRef} against \`${baseBranch}\` and OpenSpec delta spec \`${resolvedArtifacts.artifacts.deltaSpecRelativePath}\` in temporary worktree \`${worktreePath}\``,
						resolvedArtifacts.stats,
						diffResult.stdout,
						resolvedArtifacts.artifacts,
						{ reviewRoot: worktreePath },
					);
				}

				case "custom": {
					const instructions = await ctx.ui.editor(
						"Enter custom OpenSpec verification instructions",
						"Verify the following patch against the selected OpenSpec delta spec:\n\n",
					);
					if (!instructions?.trim()) return undefined;

					const repoRoot = await getRepoRoot(api);
					if (!repoRoot) {
						ctx.ui.notify("Failed to determine git repo root", "error");
						return undefined;
					}

					const diffResult = await api.exec("git", ["diff", "HEAD"], { timeout: 30000 });
					const resolvedArtifacts = diffResult.code === 0 && diffResult.stdout.trim()
						? await resolveArtifactsForDiff(api, repoRoot, diffResult.stdout, ctx.ui)
						: await (async () => {
							const selectedChange = await selectOpenSpecChange(api, repoRoot, [], ctx.ui);
							if (!selectedChange) return undefined;
							const [status, applyInstructions] = await Promise.all([
								runOpenSpecStatus(api, selectedChange.name, repoRoot),
								runOpenSpecInstructionsApply(api, selectedChange.name, repoRoot),
							]);
							const deltaSpecPath = await selectDeltaSpecForChange(applyInstructions, repoRoot, [], ctx.ui);
							if (!deltaSpecPath) return undefined;
							const artifacts = await loadOpenSpecArtifacts(repoRoot, status, applyInstructions, deltaSpecPath);
							return { stats: EMPTY_DIFF_STATS, artifacts };
						})();
					if (!resolvedArtifacts) return undefined;

					return buildOpenSpecVerifyPrompt(
						`Custom OpenSpec verification against delta spec \`${resolvedArtifacts.artifacts.deltaSpecRelativePath}\``,
						resolvedArtifacts.stats,
						diffResult.code === 0 ? diffResult.stdout : "",
						resolvedArtifacts.artifacts,
						{ additionalInstructions: instructions },
					);
				}

				default:
					return assertUnreachable(verificationMode);
			}
		},
	};
}
