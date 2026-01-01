; Workman syntax highlighting for Helix
; Based on tree-sitter-workman grammar

; Comments
(comment) @comment

; Strings and characters
(string) @string
(char) @string.special

; Numbers
(number) @constant.numeric

; Booleans
(boolean) @constant.builtin.boolean

; Keywords
(keyword) @keyword

; Type constructors (PascalCase identifiers)
(constructor) @constructor

; Identifiers (variables, functions)
(identifier) @variable

; Operators
(operator) @operator

; Punctuation and symbols
(symbol) @punctuation.delimiter
