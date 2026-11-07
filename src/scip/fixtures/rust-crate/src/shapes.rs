pub enum Kind { Round, Square }

pub struct Circle<T> { pub r: T }

impl<T: Default> Circle<T> {
    pub fn unit() -> Self { Circle { r: T::default() } }
}

pub type Radius = f64;

pub fn area(c: &Circle<f64>) -> f64 { c.r * c.r * 3.14 }

pub const MAX_SIDES: u32 = 8;

impl<T> crate::Greeter for Circle<T> {
    fn greet(&self) -> String {
        String::from("round")
    }
}

macro_rules! twice {
    ($e:expr) => { $e * 2 };
}

pub fn doubled() -> u32 {
    twice!(MAX_SIDES)
}
