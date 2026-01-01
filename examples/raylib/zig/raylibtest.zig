const c = @cImport({
    @cInclude("raylib.h");
});

const Color = c.Color;
const Vector2 = c.Vector2;

const SCREEN_WIDTH = 800;
const SCREEN_HEIGHT = 450;

pub fn main() void {
    c.InitWindow(SCREEN_WIDTH, SCREEN_HEIGHT, "Workman Raylib Test");
    c.SetTargetFPS(60);

    var ball_pos = Vector2{ .x = SCREEN_WIDTH / 2, .y = SCREEN_HEIGHT / 2 };
    var ball_vel = Vector2{ .x = 5, .y = 4 };
    const ball_radius: f32 = 20;

    while (!c.WindowShouldClose()) {
        // Update
        ball_pos.x += ball_vel.x;
        ball_pos.y += ball_vel.y;

        // Bounce off walls
        if (ball_pos.x >= SCREEN_WIDTH - ball_radius or ball_pos.x <= ball_radius) {
            ball_vel.x *= -1;
        }
        if (ball_pos.y >= SCREEN_HEIGHT - ball_radius or ball_pos.y <= ball_radius) {
            ball_vel.y *= -1;
        }

        // Draw
        c.BeginDrawing();
        c.ClearBackground(Color{ .r = 30, .g = 30, .b = 40, .a = 255 });

        c.DrawCircleV(ball_pos, ball_radius, Color{ .r = 230, .g = 100, .b = 100, .a = 255 });
        c.DrawText("Bouncing Ball - Press ESC to exit", 10, 10, 20, Color{ .r = 200, .g = 200, .b = 200, .a = 255 });
        c.DrawFPS(SCREEN_WIDTH - 100, 10);

        c.EndDrawing();
    }

    c.CloseWindow();
}
