; Workman text objects for Helix
; Note: The tree-sitter-workman grammar is token-based (flat structure),
; so text object support is limited. These capture basic elements.

; Comments as text objects
(comment) @comment.inside
(comment) @comment.around

; Strings as text objects
(string) @string.inside
(string) @string.around
