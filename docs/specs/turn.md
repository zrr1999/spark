


```rust
Type[n]: Type[n+1]
HLevel[n]: Type[n+1]



//
data Expr[T: Type] : hSet {
    Int(i64) -> Expr[i64],
    Bool(Bool) -> Expr[Bool],

    Add(Expr[i64], Expr[i64]) -> Expr[i64],
    Eq(Expr[i64], Expr[i64]) -> Expr[Bool],

    If[A: Type](
        Expr[Bool],
        Expr[A],
        Expr[A],
    ) -> Expr[A],
}

fn eval[T: Type](e: Expr[T]) -> T {
    match e {
        Expr::Int(n) => n,
        Expr::Bool(b) => b,
        Expr::Add(a, b) => eval(a) + eval(b),
        Expr::Eq(a, b) => eval(a) == eval(b),
        Expr::If(c, t, f) => {
            if eval(c) {
                eval(t)
            } else {
                eval(f)
            }
        }
    }
}
data Set[T: hSet] : hSet {
    Empty : Self,

    Insert(T, Self) : Self,

    InsertComm(x: T, y: T, s: Self)
        : Insert(x, Insert(y, s)) = Insert(y, Insert(x, s)),

    InsertIdem(x: T, s: Self)
        : Insert(x, Insert(x, s)) = Insert(x, s),
}
```
