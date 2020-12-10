import {SymbolTableVisitor as BaseVisitor} from "toy-kotlin-language-server";
import {ParseTree, TerminalNode} from "antlr4ts/tree";
import {ParserRuleContext} from "antlr4ts";
import {RoutineSymbol, ScopedSymbol, SymbolTable, VariableSymbol} from "antlr4-c3";
import { LocationLink} from "vscode-languageserver";
import {DocumentUri} from "vscode-languageserver-textdocument";
import {
    FunctionDeclarationContext,
    VariableDeclarationContext
} from "toy-kotlin-language-server/src/parser/KotlinParser";
import {Symbol} from "antlr4-c3/out/src/SymbolTable";

export class SymbolTableVisitor extends BaseVisitor {

    constructor(public documentUri: DocumentUri,
                public symbolTable = new SymbolTable("", {}),
                scope = symbolTable.addNewSymbolOfType(ScopedSymbol, undefined)) {
        super(symbolTable, scope);
    }

    visitVariableDeclaration = (ctx: VariableDeclarationContext) => {
        let varDecl = this.symbolTable.addNewSymbolOfType(VariableSymbol, this.scope, ctx.simpleIdentifier().text);
        this.registerDeclaration(varDecl, ctx, ctx.simpleIdentifier());
        return this.visitChildren(ctx);
    };

    visitFunctionDeclaration = (ctx: FunctionDeclarationContext) => {
        let fname = ctx.identifier();
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

export function findDeclaration<T extends Symbol>(
    identifier: ParseTree, type: new (...args: any[]) => T, symbolTable: SymbolTable) {
    const scope = getScope(identifier, symbolTable);
    if(scope instanceof ScopedSymbol) { //Local scope
        let decl = findDeclarationInScope(scope, identifier.text, type);
        if(decl) {
            return decl;
        }
    }
    //Global scope
    symbolTable.getSymbolsOfType(type).find(s => s.name == name);
}

function getScope(context: ParseTree, symbolTable: SymbolTable) {
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

function findDeclarationInScope<T extends Symbol>(scope: ScopedSymbol, name: string, type: new (...args: any[]) => T) {
    let symbol = scope.getSymbolsOfType(type).find(s => s.name == name);
    if(symbol) {
        return symbol;
    }
    let parent = scope.parent;
    while(parent && !(parent instanceof ScopedSymbol)) {
        parent = parent.parent;
    }
    if(parent instanceof ScopedSymbol) {
        return findDeclarationInScope(parent, name, type);
    }
    return undefined;
}
