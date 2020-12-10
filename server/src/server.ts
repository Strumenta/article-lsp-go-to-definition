/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
import {
	createConnection,
	TextDocuments,
	ProposedFeatures,
	InitializeParams,
	DidChangeConfigurationNotification,
	CompletionItem,
	CompletionItemKind,
	TextDocumentPositionParams,
	TextDocumentSyncKind,
	InitializeResult
} from 'vscode-languageserver';

import {
	TextDocument
} from 'vscode-languageserver-textdocument';

import {
	computeTokenPosition,
	getSuggestionsForParseTree, ImportHeaderContext,
	KotlinLexer,
	KotlinParser
} from 'toy-kotlin-language-server'
import {CharStreams, CommonTokenStream} from "antlr4ts";
import * as pathFunctions from "path";
import * as fs from "fs";
import fileUriToPath = require("file-uri-to-path");
import {findDeclaration, SymbolTableVisitor} from "./go-to-definition";
import {VariableSymbol} from "antlr4-c3";

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
let connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager. 
let documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;
let hasDiagnosticRelatedInformationCapability: boolean = false;

connection.onInitialize((params: InitializeParams) => {
	let capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
	);
	hasDiagnosticRelatedInformationCapability = !!(
		capabilities.textDocument &&
		capabilities.textDocument.publishDiagnostics &&
		capabilities.textDocument.publishDiagnostics.relatedInformation
	);

	const result: InitializeResult = {
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			// Tell the client that this server supports code completion.
			completionProvider: {
				resolveProvider: true
			},
			definitionProvider: true
		}
	};
	if (hasWorkspaceFolderCapability) {
		result.capabilities.workspace = {
			workspaceFolders: {
				supported: true
			}
		};
	}
	return result;
});

connection.onInitialized(() => {
	if (hasConfigurationCapability) {
		// Register for all configuration changes.
		connection.client.register(DidChangeConfigurationNotification.type, undefined);
	}
	if (hasWorkspaceFolderCapability) {
		connection.workspace.onDidChangeWorkspaceFolders(_event => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

documents.onDidChangeContent(change => {
	markForReparsing(change.document);
});

function computeBaseUri(uri: string) {
	let lastSep = uri.lastIndexOf("/");
	if (lastSep >= 0) {
		uri = uri.substring(0, lastSep + 1);
	} else {
		uri = "";
	}
	return uri;
}

function processImports(imports: ImportHeaderContext[], symbolTableVisitor: SymbolTableVisitor) {
	let uri = symbolTableVisitor.documentUri;
	let baseUri = computeBaseUri(uri);
	let basePath = ensurePath(baseUri);
	for(let i in imports) {
		const filename = imports[i].identifier().text + ".mykt";
		const filepath = basePath + filename;
		if (fs.existsSync(filepath)) {
			symbolTableVisitor.documentUri = baseUri + filename;
			processImport(filepath, symbolTableVisitor);
		} else {
			connection.window.showErrorMessage("Imported file not found: " + filepath);
		}
	}
	symbolTableVisitor.documentUri = uri;
}

function processImport(path: string, symbolTableVisitor: SymbolTableVisitor) {
	try {
		let data = fs.readFileSync(path);
		let input = CharStreams.fromString(data.toString());
		let lexer = new KotlinLexer(input);
		let parser = new KotlinParser(new CommonTokenStream(lexer));

		let parseTree = parser.kotlinFile();
		symbolTableVisitor.visit(parseTree);
	} catch (e) {
		connection.window.showErrorMessage("Cannot read from imported file " + path + ": " + e);
		console.error(e);
	}
}

function ensurePath(path: string) {
	if (path.startsWith("file:")) {
		//Decode for Windows paths like /C%3A/...
		let decoded = decodeURIComponent(fileUriToPath(path));
		if(!decoded.startsWith("\\\\") && decoded.startsWith("\\")) {
			//Windows doesn't seem to like paths like \C:\...
			decoded = decoded.substring(1);
		}
		return decoded;
	} else if(!pathFunctions.isAbsolute(path)) {
		return pathFunctions.resolve(path);
	} else {
		return path;
	}
}

connection.onDefinition((params) => {
	let uri = params.textDocument.uri;
	let document = documents.get(uri);
	let {parser, parseTree, visitor} = ensureParsed(document);
	let pos = params.position;
	let position = computeTokenPosition(parseTree, parser.inputStream,
		{ line: pos.line + 1, column: pos.character });
	if(position && position.context) {
		let declaration = findDeclaration(position.context, VariableSymbol, visitor.symbolTable);
		if(declaration && declaration.location) {
			return declaration.location;
		}
	}
	return undefined;
});

function markForReparsing(document: TextDocument) {
	document["parser"] = undefined;
	document["parseTree"] = undefined;
	document["symbolTableVisitor"] = undefined;
}

function ensureParsed(document: TextDocument) {
	if(document["parser"]) {
		return { parser: document["parser"], parseTree: document["parseTree"], visitor: document["symbolTableVisitor"] };
	}
	let input = CharStreams.fromString(document.getText());
	let lexer = new KotlinLexer(input);
	let parser = new KotlinParser(new CommonTokenStream(lexer));
	let parseTree = parser.kotlinFile();
	let imports = parseTree?.preamble()?.importList()?.importHeader();

	let symbolTableVisitor = new SymbolTableVisitor(document.uri);
	if(imports) {
		processImports(imports, symbolTableVisitor);
	}
	symbolTableVisitor.visit(parseTree);

	document["parser"] = parser;
	document["parseTree"] = parseTree;
	document["symbolTableVisitor"] = symbolTableVisitor;
	return {parser, parseTree, visitor: symbolTableVisitor};
}

// This handler provides the initial list of the completion items.
connection.onCompletion(
	(_textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
		let uri = _textDocumentPosition.textDocument.uri;
		let document = documents.get(uri);
		let pos = _textDocumentPosition.position;

		let {parser, parseTree, visitor} = ensureParsed(document);

		let position = computeTokenPosition(
			parseTree, parser.inputStream, { line: pos.line + 1, column: pos.character }, [ KotlinParser.Identifier ]);
		if(!position) {
			return [];
		}
		let suggestions = getSuggestionsForParseTree(
			parser, parseTree, () => visitor.symbolTable, position);
		return suggestions.map(s => {
			return {
				label: s,
				kind: CompletionItemKind.Keyword
			}
		});
	}
);

// This handler resolves additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
		return item;
	}
);

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
