// A minimal GraphQL parser for the subset the suite's client sends (checks-graphql.ts):
// named query/mutation operations with variable definitions, fields with aliases and
// arguments, variables, inline enums, inline input objects and lists, named and inline
// fragments, and directives (parsed and ignored). No schema is needed to parse; the
// executor validates field names against graphql/schema.ts. A parse failure throws a
// GraphQLParseError naming the position — the executor turns it into a 200 errors array,
// never a crash.

export class GraphQLParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLParseError';
  }
}

export type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'IntValue'; value: string }
  | { kind: 'FloatValue'; value: string }
  | { kind: 'StringValue'; value: string }
  | { kind: 'BooleanValue'; value: boolean }
  | { kind: 'NullValue' }
  | { kind: 'EnumValue'; value: string }
  | { kind: 'ListValue'; values: ValueNode[] }
  | { kind: 'ObjectValue'; fields: { name: string; value: ValueNode }[] };

export interface ArgumentNode {
  name: string;
  value: ValueNode;
}

export interface FieldNode {
  kind: 'Field';
  alias: string | null;
  name: string;
  arguments: ArgumentNode[];
  selectionSet: SelectionNode[] | null;
}

export type SelectionNode =
  | FieldNode
  | { kind: 'FragmentSpread'; name: string }
  | { kind: 'InlineFragment'; typeCondition: string | null; selectionSet: SelectionNode[] };

export interface VariableDefinitionNode {
  name: string;
  /** The type as written (e.g. `String!`, `[IssueState!]`); execution needs only the name. */
  type: string;
  defaultValue: ValueNode | null;
}

export interface OperationNode {
  kind: 'Operation';
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: VariableDefinitionNode[];
  selectionSet: SelectionNode[];
}

export interface FragmentNode {
  kind: 'Fragment';
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

type TokenKind =
  | 'Name'
  | 'Int'
  | 'Float'
  | 'String'
  | 'Bang'
  | 'Dollar'
  | 'ParenL'
  | 'ParenR'
  | 'Spread'
  | 'Colon'
  | 'Equals'
  | 'At'
  | 'BracketL'
  | 'BracketR'
  | 'BraceL'
  | 'BraceR'
  | 'Pipe'
  | 'Amp'
  | 'EOF';

interface Token {
  kind: TokenKind;
  value: string;
  line: number;
  column: number;
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function isNameStart(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_';
}

function isNameContinue(ch: string): boolean {
  return isNameStart(ch) || isDigit(ch);
}

/** Tokenize a document. Commas are insignificant whitespace; `#` starts a comment. */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  let column = 1;

  function fail(message: string): never {
    throw new GraphQLParseError(`${message} at line ${line}, column ${column}`);
  }

  function advance(count = 1): void {
    for (let i = 0; i < count; i += 1) {
      if (source[index] === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      index += 1;
    }
  }

  while (index < source.length) {
    const ch = source[index]!;
    // Whitespace and commas.
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      advance();
      continue;
    }
    // Comments.
    if (ch === '#') {
      while (index < source.length && source[index] !== '\n') advance();
      continue;
    }
    const startLine = line;
    const startColumn = column;
    const push = (kind: TokenKind, value: string, length: number): void => {
      tokens.push({ kind, value, line: startLine, column: startColumn });
      advance(length);
    };
    switch (ch) {
      case '!':
        push('Bang', '!', 1);
        continue;
      case '$':
        push('Dollar', '$', 1);
        continue;
      case '(':
        push('ParenL', '(', 1);
        continue;
      case ')':
        push('ParenR', ')', 1);
        continue;
      case ':':
        push('Colon', ':', 1);
        continue;
      case '=':
        push('Equals', '=', 1);
        continue;
      case '@':
        push('At', '@', 1);
        continue;
      case '[':
        push('BracketL', '[', 1);
        continue;
      case ']':
        push('BracketR', ']', 1);
        continue;
      case '{':
        push('BraceL', '{', 1);
        continue;
      case '}':
        push('BraceR', '}', 1);
        continue;
      case '|':
        push('Pipe', '|', 1);
        continue;
      case '&':
        push('Amp', '&', 1);
        continue;
      case '.':
        if (source.slice(index, index + 3) === '...') {
          push('Spread', '...', 3);
          continue;
        }
        fail('unexpected character "."');
        break;
      case '"': {
        // A string literal, with \" \\ \/ \b \f \n \r \t and \uXXXX escapes.
        // Block strings (""") are not in the suite's documents; reject them plainly.
        if (source.slice(index, index + 3) === '"""') fail('block strings are not supported');
        advance();
        let value = '';
        for (;;) {
          if (index >= source.length) fail('unterminated string');
          const c = source[index]!;
          if (c === '"') {
            advance();
            break;
          }
          if (c === '\n' || c === '\r') fail('unterminated string');
          if (c === '\\') {
            const esc = source[index + 1];
            if (esc === undefined) fail('unterminated string');
            switch (esc) {
              case '"':
                value += '"';
                advance(2);
                break;
              case '\\':
                value += '\\';
                advance(2);
                break;
              case '/':
                value += '/';
                advance(2);
                break;
              case 'b':
                value += '\b';
                advance(2);
                break;
              case 'f':
                value += '\f';
                advance(2);
                break;
              case 'n':
                value += '\n';
                advance(2);
                break;
              case 'r':
                value += '\r';
                advance(2);
                break;
              case 't':
                value += '\t';
                advance(2);
                break;
              case 'u': {
                const hex = source.slice(index + 2, index + 6);
                if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('invalid unicode escape');
                value += String.fromCharCode(Number.parseInt(hex, 16));
                advance(6);
                break;
              }
              default:
                fail(`invalid escape \\${esc}`);
            }
            continue;
          }
          value += c;
          advance();
        }
        tokens.push({ kind: 'String', value, line: startLine, column: startColumn });
        continue;
      }
      default:
        break;
    }
    // Numbers: -? Int (. Int)? (e|E (+|-)? Int)? — a leading `-` is part of the literal.
    if (ch === '-' || isDigit(ch)) {
      let value = '';
      if (ch === '-') {
        value += '-';
        advance();
        if (index >= source.length || !isDigit(source[index]!)) fail('invalid number');
      }
      while (index < source.length && isDigit(source[index]!)) {
        value += source[index]!;
        advance();
      }
      let isFloat = false;
      if (source[index] === '.' && isDigit(source[index + 1] ?? '')) {
        isFloat = true;
        value += '.';
        advance();
        while (index < source.length && isDigit(source[index]!)) {
          value += source[index]!;
          advance();
        }
      }
      const exp = source[index];
      if (exp === 'e' || exp === 'E') {
        isFloat = true;
        value += exp;
        advance();
        const sign = source[index];
        if (sign === '+' || sign === '-') {
          value += sign;
          advance();
        }
        if (index >= source.length || !isDigit(source[index]!)) fail('invalid number');
        while (index < source.length && isDigit(source[index]!)) {
          value += source[index]!;
          advance();
        }
      }
      tokens.push({ kind: isFloat ? 'Float' : 'Int', value, line: startLine, column: startColumn });
      continue;
    }
    if (isNameStart(ch)) {
      let value = '';
      while (index < source.length && isNameContinue(source[index]!)) {
        value += source[index]!;
        advance();
      }
      tokens.push({ kind: 'Name', value, line: startLine, column: startColumn });
      continue;
    }
    fail(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'EOF', value: '', line, column });
  return tokens;
}

/** A recursive-descent parser over the token stream. */
class Parser {
  private readonly tokens: Token[];
  private position = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.position]!;
  }

  private next(): Token {
    const token = this.tokens[this.position]!;
    if (this.position < this.tokens.length - 1) this.position += 1;
    return token;
  }

  private fail(message: string, token: Token = this.peek()): never {
    throw new GraphQLParseError(`${message} at line ${token.line}, column ${token.column}`);
  }

  private expect(kind: TokenKind, what: string): Token {
    const token = this.peek();
    if (token.kind !== kind) this.fail(`expected ${what}, got ${token.kind === 'Name' ? token.value : token.kind}`, token);
    return this.next();
  }

  private expectName(what = 'a name'): string {
    const token = this.peek();
    if (token.kind !== 'Name') this.fail(`expected ${what}, got ${token.kind}`, token);
    this.next();
    return token.value;
  }

  private skip(kind: TokenKind): boolean {
    if (this.peek().kind === kind) {
      this.next();
      return true;
    }
    return false;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'EOF') {
      const token = this.peek();
      if (token.kind === 'BraceL') {
        operations.push({
          kind: 'Operation',
          operation: 'query',
          name: null,
          variableDefinitions: [],
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.kind !== 'Name') this.fail('expected an operation or fragment definition', token);
      const keyword = token.value;
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        this.next();
        operations.push(this.parseOperation(keyword));
        continue;
      }
      if (keyword === 'fragment') {
        this.next();
        const fragment = this.parseFragment();
        fragments.set(fragment.name, fragment);
        continue;
      }
      this.fail(`unexpected keyword ${JSON.stringify(keyword)}`, token);
    }
    if (operations.length === 0) this.fail('the document holds no operation');
    return { operations, fragments };
  }

  private parseOperation(operation: 'query' | 'mutation' | 'subscription'): OperationNode {
    let name: string | null = null;
    if (this.peek().kind === 'Name') name = this.expectName('an operation name');
    const variableDefinitions = this.peek().kind === 'ParenL' ? this.parseVariableDefinitions() : [];
    this.parseDirectives();
    return { kind: 'Operation', operation, name, variableDefinitions, selectionSet: this.parseSelectionSet() };
  }

  private parseVariableDefinitions(): VariableDefinitionNode[] {
    this.expect('ParenL', '"("');
    const definitions: VariableDefinitionNode[] = [];
    while (this.peek().kind !== 'ParenR') {
      this.expect('Dollar', '"$"');
      const name = this.expectName('a variable name');
      this.expect('Colon', '":"');
      const type = this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.skip('Equals')) defaultValue = this.parseValue(true);
      this.parseDirectives();
      definitions.push({ name, type, defaultValue });
    }
    this.expect('ParenR', '")"');
    return definitions;
  }

  /** A type as written: `Name`, `Name!`, `[Name]`, `[Name!]!` (nested lists allowed). */
  private parseType(): string {
    if (this.skip('BracketL')) {
      const inner = this.parseType();
      this.expect('BracketR', '"]"');
      return `[${inner}]${this.skip('Bang') ? '!' : ''}`;
    }
    const name = this.expectName('a type name');
    return `${name}${this.skip('Bang') ? '!' : ''}`;
  }

  private parseFragment(): FragmentNode {
    const name = this.expectName('a fragment name');
    if (name === 'on') this.fail('a fragment cannot be named "on"');
    const on = this.expectName('"on"');
    if (on !== 'on') this.fail('expected "on" after a fragment name');
    const typeCondition = this.expectName('a type name');
    this.parseDirectives();
    return { kind: 'Fragment', name, typeCondition, selectionSet: this.parseSelectionSet() };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('BraceL', '"{"');
    const selections: SelectionNode[] = [];
    while (this.peek().kind !== 'BraceR') {
      selections.push(this.parseSelection());
    }
    this.expect('BraceR', '"}"');
    if (selections.length === 0) this.fail('an empty selection set');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'Spread') {
      this.next();
      if (this.peek().kind === 'Name' && this.peek().value !== 'on') {
        const name = this.expectName('a fragment name');
        this.parseDirectives();
        return { kind: 'FragmentSpread', name };
      }
      let typeCondition: string | null = null;
      if (this.peek().kind === 'Name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName('a type name');
      }
      this.parseDirectives();
      return { kind: 'InlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
    }
    let name = this.expectName('a field name');
    let alias: string | null = null;
    if (this.skip('Colon')) {
      alias = name;
      name = this.expectName('a field name');
    }
    const args = this.peek().kind === 'ParenL' ? this.parseArguments() : [];
    this.parseDirectives();
    const selectionSet = this.peek().kind === 'BraceL' ? this.parseSelectionSet() : null;
    return { kind: 'Field', alias, name, arguments: args, selectionSet };
  }

  private parseArguments(): ArgumentNode[] {
    this.expect('ParenL', '"("');
    const args: ArgumentNode[] = [];
    while (this.peek().kind !== 'ParenR') {
      const name = this.expectName('an argument name');
      this.expect('Colon', '":"');
      args.push({ name, value: this.parseValue(false) });
    }
    this.expect('ParenR', '")"');
    return args;
  }

  /** Directives are parsed and dropped: the suite sends none, and ignoring them is safer than failing. */
  private parseDirectives(): void {
    while (this.peek().kind === 'At') {
      this.next();
      this.expectName('a directive name');
      if (this.peek().kind === 'ParenL') this.parseArguments();
    }
  }

  private parseValue(constant: boolean): ValueNode {
    const token = this.peek();
    switch (token.kind) {
      case 'Dollar': {
        if (constant) this.fail('a variable is not allowed here', token);
        this.next();
        return { kind: 'Variable', name: this.expectName('a variable name') };
      }
      case 'Int':
        this.next();
        return { kind: 'IntValue', value: token.value };
      case 'Float':
        this.next();
        return { kind: 'FloatValue', value: token.value };
      case 'String':
        this.next();
        return { kind: 'StringValue', value: token.value };
      case 'Name': {
        this.next();
        if (token.value === 'true') return { kind: 'BooleanValue', value: true };
        if (token.value === 'false') return { kind: 'BooleanValue', value: false };
        if (token.value === 'null') return { kind: 'NullValue' };
        return { kind: 'EnumValue', value: token.value };
      }
      case 'BracketL': {
        this.next();
        const values: ValueNode[] = [];
        while (this.peek().kind !== 'BracketR') values.push(this.parseValue(constant));
        this.expect('BracketR', '"]"');
        return { kind: 'ListValue', values };
      }
      case 'BraceL': {
        this.next();
        const fields: { name: string; value: ValueNode }[] = [];
        while (this.peek().kind !== 'BraceR') {
          const name = this.expectName('an object field name');
          this.expect('Colon', '":"');
          fields.push({ name, value: this.parseValue(constant) });
        }
        this.expect('BraceR', '"}"');
        return { kind: 'ObjectValue', fields };
      }
      default:
        this.fail(`expected a value, got ${token.kind}`, token);
    }
  }
}

/** Parse a GraphQL document string into its AST. Throws GraphQLParseError on bad syntax. */
export function parseDocument(source: string): DocumentNode {
  return new Parser(source).parseDocument();
}

/**
 * Resolve an AST value to a plain JSON value: variables come from `variables`, enums become
 * their name string, objects become records, lists become arrays. An absent variable is
 * undefined (the field resolvers treat it as an absent argument).
 */
export function valueFromAst(node: ValueNode, variables: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case 'Variable':
      return variables[node.name];
    case 'IntValue':
      return Number.parseInt(node.value, 10);
    case 'FloatValue':
      return Number.parseFloat(node.value);
    case 'StringValue':
      return node.value;
    case 'BooleanValue':
      return node.value;
    case 'NullValue':
      return null;
    case 'EnumValue':
      return node.value;
    case 'ListValue':
      return node.values.map((value) => valueFromAst(value, variables));
    case 'ObjectValue': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFromAst(field.value, variables);
      return out;
    }
  }
}
