# The oldest members can be removed together

Removing one member keeps the membership id, the name, and the email. That account loses access to the project. API keys stay, because a key belongs to the project. The owner is not a member row, so removing members cannot remove the owner. When several people should leave the project, removing each row is the wrong tool. `POST /members/remove` takes a limit from 1 to 50, reads the oldest memberships that are still present, and uses the same removal as a single member. Each membership id stays.

A member who already left is left alone. A second call returns `removed: 0` once those memberships are closed. The caller repeats the request when more than 50 members remain. Only the owner can call it.
