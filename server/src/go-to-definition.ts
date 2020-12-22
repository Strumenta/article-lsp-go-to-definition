import {SymbolTableVisitor as BaseVisitor} from "toy-kotlin-language-server";
import {ParseTree, TerminalNode} from "antlr4ts/tree";
import {ParserRuleContext} from "antlr4ts";
import {RoutineSymbol, ScopedSymbol, SymbolTable, VariableSymbol, Symbol as BaseSymbol} from "antlr4-c3";
import { LocationLink} from "vscode-languageserver";
import {DocumentUri} from "vscode-languageserver-textdocument";
import {
    FunctionDeclarationContext,
    VariableDeclarationContext
} from "toy-kotlin-language-server/src/parser/KotlinParser";

export class SymbolTableVisitor extends BaseVisitor {

    constructor(public documentUri: DocumentUri,
                public symbolTable = new SymbolTable("", {}),
                scope = symbolTable.addNewSymbolOfType(ScopedSymbol, undefined)) {
        super(symbolTable, scope);
    }

    visitVariableDeclaration = (ctx: VariableDeclarationContext) => {
        const symbol = this.symbolTable.addNewSymbolOfType(VariableSymbol, this.scope, ctx.simpleIdentifier().text);
        this.registerDeclaration(symbol, ctx, ctx.simpleIdentifier());
        return this.visitChildren(ctx);
    };

    visitFunctionDeclaration = (ctx: FunctionDeclarationContext) => {
        const fname = ctx.identifier();
        return this.withDeclaration(ctx, fname, RoutineSymbol, [fname.text],
            () => this.visitChildren(ctx));
    };

    protected withDeclaration<T>(
        declaration: ParseTree, declarationName: ParseTree,
        type: { new(...args: any[]): ScopedSymbol }, args: any[], action: () => T): T {
        return this.withScope(declaration, type, args, () => {
            this.registerDeclaration(this.scope, declaration, declarationName);
            return action();
        });
    }

    protected registerDeclaration(symbol: any, tree: ParseTree, declarationName: ParseTree) {
        symbol.location = LocationLink.create(this.documentUri, getRange(tree), getRange(declarationName));
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
    const endCharacter = stop.charPositionInLine + stop.text.length;
    return {
        start: { line: start.line - 1, character: start.charPositionInLine },
        end: {   line: stop.line - 1,  character: endCharacter
        }
    };
}

export function findDeclaration(name: string, scope: BaseSymbol) {
    while(scope && !(scope instanceof ScopedSymbol)) {
        scope = scope.parent;
    }
    if(!scope) {
        return undefined;
    }
    const symbol = (scope as ScopedSymbol).getSymbolsOfType(BaseSymbol).find(s => s.name == name);
    if(symbol && symbol.hasOwnProperty("location")) {
        return symbol;
    } else {
        return findDeclaration(name, scope.parent);
    }
}

export function getScope(context: ParseTree, symbolTable: SymbolTable) {
    if(!context) {
        return undefined;
    }
    const scope = symbolTable.symbolWithContext(context);
    if(scope) {
        return scope;
    } else {
        return getScope(context.parent, symbolTable);
    }
}
