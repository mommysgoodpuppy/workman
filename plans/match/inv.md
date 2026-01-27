
Pattern-Matching as Inverse

V. E. McHale

20 Oct. 2025

Suppose we have

type Pair a b = { a b `pair };

Then `pair has type

`pair : a b -- Pair(a,b)

Given atoms of types a, b on the stack, it will leave an atom of type Pair(a,b) in their place. The inverse `pair⁻¹ should then take an atom of type Pair(a,b) and leave two atoms of types a, b on the stack:

`pair⁻¹ : Pair(a,b) -- a b

Inverse exchanges left and right.

This is not new (Ehrenberg 2009). However, with pattern match arms as first-class (typed) atoms, we can implement & which juxtaposes two inverse constructors to form a pattern match clause handling a sum type, viz.

type Maybe a = { a `just ⊕ `nothing };

isJust : Maybe(a) -- Bool
       := [ { `just⁻¹ drop True
            & `nothing⁻¹ False }
          ]

This is inspired by linear logic’s
—to invert a sum type, one supplies an inverse (pattern match clause) for each summand. This is precisely the De Morgan laws. We have two choices to return a value of type Maybe(a), and, dually, to accept a value of type Maybe(a) as argument, we must write two pattern-match clauses. This is hardly a stretch—that

is the type of a pattern match was pointed out by Munch-Maccagnoni (2009).

In fact, pattern match exhaustiveness checking falls out for free in this scheme. Had we written

isJust : Maybe(a) -- Bool
       := [ { `just⁻¹ drop True } ]

we would be confronted with

5:20: {a `just ⊕ `nothing} ⊀ {ρ₁ `just}

References
Ehrenberg, Daniel. 2009. “Pattern Matching in Concatenative Programming Languages.” http://micsymposium.org/mics_2009_proceedings/mics2009_submission_72.pdf.
Munch-Maccagnoni, Guillaume. 2009. “Focalisation and Classical Realisability.” In Computer Science Logic, edited by Erich Grädel and Reinhard Kahle. Springer Berlin Heidelberg.
