; Workman indentation rules for Helix
; Note: The tree-sitter-workman grammar is token-based, so indentation 
; support is limited. These are basic rules.

; Increase indent after opening brackets
((symbol) @indent
  (#match? @indent "^[{\\[\\(]$"))

; Decrease indent at closing brackets  
((symbol) @outdent
  (#match? @outdent "^[}\\]\\)]$"))
