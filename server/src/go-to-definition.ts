import {SymbolTableVisitor as BaseVisitor} from "toy-kotlin-language-server";
import {ParseTree, TerminalNode} from "antlr4ts/tree";
import {ParserRuleContext} from "antlr4ts";
import {RoutineSymbol, ScopedSymbol, SymbolTable, VariableSymbol} from "antlr4-c3";
import { LocationLink, Range } from "vscode-languageserver";
import {DocumentUri} from "vscode-languageserver-textdocument";
import {
    FunctionDeclarationContext,
    VariableDeclarationContext
} from "toy-kotlin-language-server/src/parser/KotlinParser";

export class SymbolTableVisitor extends BaseVisitor {

    protected declarationName: ParseTree;

    constructor(public documentUri: DocumentUri,
                symbolTable = new SymbolTable("", {}),
                scope = symbolTable.addNewSymbolOfType(ScopedSymbol, undefined)) {
        super(symbolTable, scope);
    }

    visitVariableDeclaration = (ctx: VariableDeclarationContext) => {
        let varDecl = this.symbolTable.addNewSymbolOfType(VariableSymbol, this.scope, ctx.simpleIdentifier().text);
        this.registerDeclaration(varDecl, ctx, ctx.simpleIdentifier());
        return this.visitChildren(ctx);
    };

    visitFunctionDeclaration = (ctx: FunctionDeclarationContext) => {
        this.declarationName = ctx.identifier();
        return this.withScope(ctx, RoutineSymbol, [ctx.identifier().text], () => this.visitChildren(ctx));
    };

    protected withScope<T>(tree: ParseTree, type: { new(...args: any[]): ScopedSymbol }, args: any[], action: () => T): T {
        return super.withScope(tree, type, args, () => {
            this.registerDeclaration(this.scope, tree, this.declarationName);
            return action();
        });
    }

    protected registerDeclaration(declaration: any, tree: ParseTree, declarationName: ParseTree) {
        declaration.location = LocationLink.create(this.documentUri, getRange(tree), getRange(declarationName));
    }
}

export function getRange(parseTree: ParseTree) {
    let start, stop;
    if(parseTree instanceof ParserRuleContext) {
        start = parseTree.start;
        stop = parseTree.stop;
    } else if(parseTree instanceof TerminalNode) {
        start = stop = parseTree.symbol;
    }
    let endCharacter = stop.charPositionInLine + stop.text.length;
    return {
        start: { line: start.line - 1, character: start.charPositionInLine },
        end: {
            line: stop.line - 1,
            character: endCharacter
        }
    };
}