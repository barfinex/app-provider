import { Column, Entity, ObjectId, ObjectIdColumn, CreateDateColumn, UpdateDateColumn } from "typeorm";

@Entity()
export class ConnectorEntity {

    @ObjectIdColumn()
    id!: ObjectId;

    @Column()
    connectorType!: string;

    @Column()
    options!: string;

    @CreateDateColumn({ type: 'timestamptz' })
    created!: Date;

    @UpdateDateColumn({ type: 'timestamptz' })
    updated!: Date;
}