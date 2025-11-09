db = db.getSiblingDB('barfindb') // Creates or selects the "barfindb" database
db.createCollection('users')  // Creates the "users" collection
db.createUser(
    {
        user: "admin",
        pwd: "password",
        roles: [
            {
                role: "readWrite",
                db: "barfindb"
            },
            { role: "root", db: "admin" }
        ]
    }
)
db.createCollection('transactions') // Creates the "transactions" collection
print('Database initialization completed.')
