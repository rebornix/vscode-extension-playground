import * as vscode from 'vscode';
import * as path from 'path';
import * as ts from "typescript";

function compile(fileNames: string[], options: ts.CompilerOptions): void {
	let program = ts.createProgram(fileNames, options);
	let emitResult = program.emit();

	let allDiagnostics = ts
		.getPreEmitDiagnostics(program)
		.concat(emitResult.diagnostics);

	allDiagnostics.forEach(diagnostic => {
		if (diagnostic.file) {
			let { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start!);
			let message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
			console.log(`${diagnostic.file.fileName} (${line + 1},${character + 1}): ${message}`);
		} else {
			console.log(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
		}
	});

	let exitCode = emitResult.emitSkipped ? 1 : 0;
	console.log(`Process exiting with code '${exitCode}'.`);
	process.exit(exitCode);
}

class ExtensionPlaygroundNotebookProvider implements vscode.NotebookContentProvider {
	private _onDidChangeNotebook = new vscode.EventEmitter<vscode.NotebookDocumentContentChangeEvent | vscode.NotebookDocumentEditEvent>();
	onDidChangeNotebook: vscode.Event<vscode.NotebookDocumentContentChangeEvent | vscode.NotebookDocumentEditEvent> = this._onDidChangeNotebook.event;

	constructor() {
	}

	async openNotebook(uri: vscode.Uri, openContext: vscode.NotebookDocumentOpenContext): Promise<vscode.NotebookData> {
		const templateCells: vscode.NotebookCellData[] = [
			{
				cellKind: vscode.CellKind.Markdown,
				source: '## package.json',
				language: 'markdown',
				outputs: [],
				metadata: {}
			},
			{
				cellKind: vscode.CellKind.Code,
				source: '{}',
				language: 'json',
				outputs: [],
				metadata: {}
			},
			{
				cellKind: vscode.CellKind.Markdown,
				source: '## extension',
				language: 'markdown',
				outputs: [],
				metadata: {}
			},
			{
				cellKind: vscode.CellKind.Code,
				source: `import * as vscode from 'vscode';`,
				language: 'typescript',
				outputs: [],
				metadata: {}
			},
		];

		if (uri.scheme === 'untitled') {
			return {
				metadata: {},
				cells: templateCells,
				languages: ['typescript', 'json']
			};
		}
		const buffer = await vscode.workspace.fs.readFile(uri);
		const data = buffer.toString();

		try {
			const obj = JSON.parse(data);
			const cells: vscode.NotebookCellData[] = obj.cells.map((element: any) => ({
				cellKind: element.cellKind === 'code' ? vscode.CellKind.Code : vscode.CellKind.Markdown,
				source: element.source,
				language: element.language,
				outputs: [],
				metadata: {}
			}));

			return {
				metadata: {},
				cells,
				languages: ['typescript', 'json']
			};
		} catch (e) {
			return {
				metadata: {},
				cells: templateCells,
				languages: ['typescript', 'json']
			};
		}
	}
	async resolveNotebook(document: vscode.NotebookDocument, webview: vscode.NotebookCommunication): Promise<void> {
	}

	async saveNotebook(document: vscode.NotebookDocument, cancellation: vscode.CancellationToken): Promise<void> {
		const data = this._serialize(document);
		await vscode.workspace.fs.writeFile(document.uri, Buffer.from(data));
	}

	async saveNotebookAs(targetResource: vscode.Uri, document: vscode.NotebookDocument, cancellation: vscode.CancellationToken): Promise<void> {
		const data = this._serialize(document);
		await vscode.workspace.fs.writeFile(targetResource, Buffer.from(data));
	}

	async backupNotebook(document: vscode.NotebookDocument, context: vscode.NotebookDocumentBackupContext, cancellation: vscode.CancellationToken): Promise<vscode.NotebookDocumentBackup> {
		const data = this._serialize(document);
		await vscode.workspace.fs.writeFile(context.destination, Buffer.from(data));

		return {
			id: context.destination.toString(),
			delete: () => {
				vscode.workspace.fs.delete(context.destination);
			}
		};
	}

	private _serialize(document: vscode.NotebookDocument) {
		const data = {
			metadata: {},
			cells: document.cells.map(cell => ({
				cellKind: cell.cellKind === vscode.CellKind.Code ? 'code' : 'markdown',
				source: cell.document.getText(),
				language: cell.language
			}))
		};

		return JSON.stringify(data);
	}

}

class Kernel implements vscode.NotebookKernel {
	id?: string = 'extension-runtime-kernel';
	label: string = 'VS Code Extension Runtime';
	isPreferred = true;
	async executeCell(document: vscode.NotebookDocument, cell: vscode.NotebookCell) {
		const jsonPackage = document.cells.find(cell => cell.language === 'json');
		if (!jsonPackage) {
			return;
		}
		const packageJson = jsonPackage.document.getText();
		const tsValue = cell.document.getText();
		const workspaceFolder = (vscode.workspace.workspaceFolders || [])[0];
		if (!workspaceFolder) {
			return;
		}

		cell.metadata = {
			...cell.metadata,
			runState: vscode.NotebookCellRunState.Running
		};

		const existingFiles = await vscode.workspace.fs.readDirectory(vscode.Uri.parse(path.join(workspaceFolder.uri.path, 'dist')));
		await Promise.all(existingFiles.map(file => vscode.workspace.fs.delete(vscode.Uri.parse(path.join(workspaceFolder.uri.path, 'dist', file[0])))));
		const jsonTarget = vscode.Uri.file(path.join(workspaceFolder.uri.path, 'dist', 'package.json'));
		const tsTarget = vscode.Uri.file(path.join(workspaceFolder.uri.path, 'dist', 'extension.ts'));
		await vscode.workspace.fs.writeFile(jsonTarget, Buffer.from(packageJson));
		await vscode.workspace.fs.writeFile(tsTarget, Buffer.from(tsValue));

		compile([tsTarget.fsPath], {
			noEmitOnError: false,
			noImplicitAny: true,
			target: ts.ScriptTarget.ES2019,
			module: ts.ModuleKind.CommonJS,
		});

		cell.metadata = {
			...cell.metadata,
			runState: vscode.NotebookCellRunState.Success
		};
	}

	cancelCellExecution(document: vscode.NotebookDocument, cell: vscode.NotebookCell): void {

	}

	executeAllCells(document: vscode.NotebookDocument): void {

	}
	cancelAllCellsExecution(document: vscode.NotebookDocument): void {

	}
}

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(vscode.notebook.registerNotebookContentProvider('vscode-extension-playground', new ExtensionPlaygroundNotebookProvider()));
	const kernel = new Kernel();
	context.subscriptions.push(vscode.notebook.registerNotebookKernelProvider({ viewType: 'vscode-extension-playground' }, {
		provideKernels: () => {
			return [kernel];
		}
	}));
}
