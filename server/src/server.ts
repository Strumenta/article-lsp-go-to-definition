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
} from 'toy-kotlin-language-server';
import {CharStreams, CommonTokenStream} from "antlr4ts";
import * as pathFunctions from "path";
import * as fs from "fs";
import fileUriToPath = require("file-uri-to-path");
import {findDeclaration, getRange, getScope, SymbolTableVisitor} from "./go-to-definition";

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager. 
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;

connection.onInitialize((params: InitializeParams) => {
	const capabilities = params.capabilities;

	// Does the client support the `workspace/configuration` request?
	// If not, we fall back using global settings.
	hasConfigurationCapability = !!(
		capabilities.workspace && !!capabilities.workspace.configuration
	);
	hasWorkspaceFolderCapability = !!(
		capabilities.workspace && !!capabilities.workspace.workspaceFolders
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
		connection.workspace.onDidChangeWorkspaceFolders(() => {
			connection.console.log('Workspace folder change event received.');
		});
	}
});

documents.onDidChangeContent(change => {
	markForReparsing(change.document);
});

function computeBaseUri(uri: string) {
	const lastSep = uri.lastIndexOf("/");
	if (lastSep >= 0) {
		uri = uri.substring(0, lastSep + 1);
	} else {
		uri = "";
	}
	return uri;
}

function processImports(imports: ImportHeaderContext[], symbolTableVisitor: SymbolTableVisitor) {
	const uri = symbolTableVisitor.documentUri;
	const baseUri = computeBaseUri(uri);
	const basePath = ensurePath(baseUri);
	for(const i in imports) {
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
		const data = fs.readFileSync(path);
		const input = CharStreams.fromString(data.toString());
		const lexer = new KotlinLexer(input);
		const parser = new KotlinParser(new CommonTokenStream(lexer));

		const parseTree = parser.kotlinFile();
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
	const uri = params.textDocument.uri;
	const document = documents.get(uri);
	const {parser, parseTree, visitor} = ensureParsed(document);
	const pos = params.position;
	const position = computeTokenPosition(parseTree, parser.inputStream,
		{ line: pos.line + 1, column: pos.character });
	if(position && position.context) {
		const scope = getScope(position.context, visitor.symbolTable);
		const declaration = findDeclaration(position.context.text, scope);
		if(declaration && declaration.location) {
			return {...declaration.location, originSelectionRange: getRange(position.context) };
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
	const input = CharStreams.fromString(document.getText());
	const lexer = new KotlinLexer(input);
	const parser = new KotlinParser(new CommonTokenStream(lexer));
	const parseTree = parser.kotlinFile();
	const symbolTableVisitor = new SymbolTableVisitor(document.uri);

	const imports = parseTree?.preamble()?.importList()?.importHeader();
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
		const uri = _textDocumentPosition.textDocument.uri;
		const document = documents.get(uri);
		const pos = _textDocumentPosition.position;

		const {parser, parseTree, visitor} = ensureParsed(document);

		const position = computeTokenPosition(
			parseTree, parser.inputStream, { line: pos.line + 1, column: pos.character }, [ KotlinParser.Identifier ]);
		if(!position) {
			return [];
		}
		const suggestions = getSuggestionsForParseTree(
			parser, parseTree, () => visitor.symbolTable, position);
		return suggestions.map(s => {
			return {
				label: s,
				kind: CompletionItemKind.Keyword
			};
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
