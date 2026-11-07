pub mod shapes;

pub trait Greeter {
    fn greet(&self) -> String;
}

pub struct Person {
    pub name: String,
}

impl Person {
    pub fn new(name: &str) -> Self {
        Person { name: name.to_string() }
    }
}

impl Greeter for Person {
    fn greet(&self) -> String {
        format!("hi {}", self.name)
    }
}

pub fn run() -> String {
    let p = Person::new("a");
    let s = shapes::Circle::<f64>::unit();
    let _ = inner::helper();
    let _ = shapes::area(&s);
    p.greet()
}

mod inner {
    pub fn helper() -> u32 { 1 }
}
